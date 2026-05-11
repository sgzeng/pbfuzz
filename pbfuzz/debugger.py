from __future__ import annotations
import concurrent.futures
import asyncio
import inspect
import signal
import time
import os
import shutil
import subprocess
import tempfile

import psutil
import utils
from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional
try:

    from dap_types import StoppedEvent, StackFrame, ExitedEvent, OutputEvent
    from pydantic import BaseModel, Field
    from dap_mcp.factory import DAPClientSingletonFactory
    from dap_mcp.debugger import (
        Debugger, LaunchRequestArguments, SetBreakpointsResponse,
        ErrorResponse, StoppedDebuggerView, EventListView,
    )

    class RuntimeFeedback(BaseModel):
        stdout: bytes
        stderr: bytes
        reports: dict[int, BreakpointReport]
        timeout: bool
        exit_code: Optional[int]
        signal: Optional[str]

    class BreakpointSpec(BaseModel):
        location: str
        hit_limit: int = 10
        inline_expr: list[str] = Field(default_factory=list)
        print_call_stack: bool = False

        @property
        def file_path(self) -> str:
            fp, _ = self.location.rsplit(":", 1)
            return fp

        @property
        def line_no(self) -> int:
            _, ln = self.location.rsplit(":", 1)
            return int(ln)

    class InlineExprValue(BaseModel):
        name: str
        value: str

    class BreakpointHitInfo(BaseModel):
        callstack: str
        inline_expr: list[InlineExprValue]

    class BreakpointReport(BaseModel):
        id: int
        file_path: str
        line: int
        function_name: str
        hit_times: int
        hits_info: list[BreakpointHitInfo]

    class RuntimeFeedbackV2(BaseModel):
        stderr: str
        exit_code: Optional[int]
        signal: Optional[str]
        breakpoints: list[BreakpointReport]
        has_timeout: bool

    def _find_lldb_adapter(lldb_path: Optional[Path] = None) -> Tuple[str, List[str]]:
        if lldb_path:
            p = Path(lldb_path)
            if p.name in ("lldb-dap", "lldb-dap-20", "lldb-vscode") and p.exists():
                return str(p), []
            for name in ("lldb-dap", "lldb-dap-20", "lldb-vscode"):
                cand = p.parent / name
                if cand.exists():
                    return str(cand), []
        for name in ("lldb-dap", "lldb-dap-20", "lldb-vscode"):
            cmd = shutil.which(name)
            if cmd:
                return cmd, []
        raise RuntimeError("LLDB DAP adapter not found (lldb-dap or lldb-vscode)")

    def _get_source_map(lldb_path: str, executable_path: str) -> list[Path]:
        llvm_dwarfdump_path = lldb_path.replace("lldb-dap", "llvm-dwarfdump").replace("lldb-vscode", "llvm-dwarfdump")
        if not Path(llvm_dwarfdump_path).exists():
            return []
        try:
            out = subprocess.check_output([llvm_dwarfdump_path, "--show-sources", executable_path], text=True, errors="ignore")
            return [Path(line.strip()).resolve() for line in out.splitlines() if line.strip()]
        except:
            return []

    def _format_single_frame(frame: StackFrame) -> str:
        return f"{frame.name} at {frame.source.name}:{frame.line}" if frame.source else frame.name

    def _compact_backtrace(frames: list[StackFrame]) -> str:
        return "\n".join(f"{'*' if i == 0 else ' '} #{i}: {_format_single_frame(f)}" for i, f in enumerate(frames))


    class RuntimeDebugger:
        def __init__(self, config):
            self.lldb_path = None
            self.env = None
            self.repo_dir = None
            self._source_map_cache = {}
            
            # Performance optimization caches
            self._adapter_cache = None
            self._location_cache = {}  # location -> (file_path, line_no)
            
            # Reusable thread pool for async operations
            self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            
            # Fixed stdio paths for reuse with unique instance tag
            instance_tag = hex(id(self))[-5:]
            tmp = Path(tempfile.gettempdir())
            self._stdout_path = tmp / f"dbg_stdout_{os.getpid()}_{instance_tag}"
            self._stderr_path = tmp / f"dbg_stderr_{os.getpid()}_{instance_tag}"
            self._stdin_path = tmp / f"dbg_stdin_{os.getpid()}_{instance_tag}"
            for p in (self._stdout_path, self._stderr_path, self._stdin_path):
                try:
                    p.touch(exist_ok=True)
                except Exception:
                    pass
            
            if config:
                self._load_from_config(config)
            else:
                self._load_default_config()
            utils.disable_core_dump()
            
            # Pre-cache adapter to avoid repeated filesystem searches
            try:
                self._adapter_cache = _find_lldb_adapter(lldb_path=self.lldb_path)
            except Exception:
                self._adapter_cache = (None, [])

        def _load_from_config(self, config):
            if config.lldb_path:
                path = Path(config.lldb_path)
                self.lldb_path = path if path.exists() else self._auto_find_lldb_path()
            else:
                self.lldb_path = self._auto_find_lldb_path()

            if config.debugger_env:
                self.env = config.debugger_env.copy()

            self._update_path_with_lldb()

            if config.source_code_dir:
                path = config.source_code_dir if isinstance(config.source_code_dir, Path) else Path(config.source_code_dir)
                self.repo_dir = path if path.exists() and path.is_dir() else None

        @staticmethod
        def _auto_find_lldb_path() -> Optional[Path]:
            import glob
            import re

            lldb_paths = glob.glob("/usr/bin/lldb*")
            main_lldb_paths = [p for p in lldb_paths if re.match(r"^lldb(-\d+)?$", Path(p).name)]
            
            if not main_lldb_paths:
                return None

            def version_key(path):
                match = re.search(r"-(\d+)$", Path(path).name)
                return int(match.group(1)) if match else 0

            main_lldb_paths.sort(key=version_key, reverse=True)

            for path in main_lldb_paths:
                lldb_path = Path(path)
                if lldb_path.exists() and lldb_path.is_file():
                    try:
                        resolved_path = lldb_path.resolve()
                        if resolved_path.exists() and resolved_path.is_file():
                            return resolved_path
                    except:
                        continue
            return None

        def _update_path_with_lldb(self):
            if not self.lldb_path:
                return

            lldb_dir = str(self.lldb_path.parent)
            if self.env is None:
                self.env = os.environ.copy()

            current_path = self.env.get("PATH", "")
            path_dirs = current_path.split(os.pathsep) if current_path else []
            if lldb_dir not in path_dirs:
                new_path = lldb_dir + (os.pathsep + current_path if current_path else "")
                self.env["PATH"] = new_path

        def _load_default_config(self):
            self.lldb_path = self._auto_find_lldb_path()
            self.env = None
            self.repo_dir = None
            self._update_path_with_lldb()

        def _prepare_stdio_files(self, stdin_bytes: Optional[bytes]) -> None:
            """Prepare fixed stdio files for reuse, truncating and rewriting as needed."""
            # Truncate stdout/stderr files
            for p in (self._stdout_path, self._stderr_path):
                try:
                    with open(p, "wb") as f:
                        f.truncate(0)
                except Exception:
                    pass
            
            # Rewrite stdin if provided
            if stdin_bytes is not None:
                try:
                    with open(self._stdin_path, "wb") as f:
                        f.write(stdin_bytes)
                        f.flush()
                        os.fsync(f.fileno())
                except Exception:
                    pass
            else:
                # Ensure no leftover input
                try:
                    with open(self._stdin_path, "wb") as f:
                        f.truncate(0)
                except Exception:
                    pass

        def _collect_children_pids(self, root_pid: int) -> set[int]:
            # Linux-only: walk /proc to get process tree
            # Returns the set of pids of the entire tree including root_pid
            try:
                ppid_map = {}
                for pid in filter(str.isdigit, os.listdir("/proc")):
                    stat_path = f"/proc/{pid}/stat"
                    try:
                        with open(stat_path, "r") as f:
                            s = f.read().split()
                            cur_pid = int(s[0]); ppid = int(s[3])
                            ppid_map.setdefault(ppid, []).append(cur_pid)
                    except Exception:
                        continue
                tree, q = set([root_pid]), [root_pid]
                while q:
                    p = q.pop()
                    for ch in ppid_map.get(p, []):
                        if ch not in tree:
                            tree.add(ch); q.append(ch)
                return tree
            except Exception:
                return set([root_pid])

        def _kill_tree(self, root_pid: int, term_timeout: float = 0.15):
            if not root_pid: 
                return
            pids = self._collect_children_pids(root_pid)
            # First TERM
            for p in pids:
                try: os.kill(p, signal.SIGTERM)
                except Exception: pass
            time.sleep(term_timeout)
            # Remaining strong kill
            for p in list(pids):
                try:
                    os.kill(p, 0)  # 仍存活
                    try: os.kill(p, signal.SIGKILL)
                    except Exception: pass
                except Exception:
                    pass  # 已退出

        async def _run_dap(self, cmd: List[str], stdin_bytes: Optional[bytes],
                              fast_breakpoints: List[Dict[str, Any]], exec_timeout_sec: Optional[float] = None) -> RuntimeFeedbackV2:
            
            # Fast fail: check command validity
            if not cmd or not cmd[0]:
                return RuntimeFeedbackV2(
                    stderr="No command provided",
                    exit_code=-1,
                    signal=None,
                    breakpoints=[],
                    has_timeout=False
                )
            
            # Quick exit if adapter not available
            if not self._adapter_cache or not self._adapter_cache[0]:
                return RuntimeFeedbackV2(
                    stderr="LLDB adapter not available",
                    exit_code=-1,
                    signal=None,
                    breakpoints=[],
                    has_timeout=False
                )
            
            # Fast fail: check program exists
            try:
                program_path = Path(cmd[0]).resolve()
                if not program_path.exists():
                    return RuntimeFeedbackV2(
                        stderr=f"Program not found: {cmd[0]}",
                        exit_code=-1,
                        signal=None,
                        breakpoints=[],
                        has_timeout=False
                    )
                program = str(program_path)
            except Exception as e:
                return RuntimeFeedbackV2(
                    stderr=f"Invalid program path: {cmd[0]} - {str(e)}",
                    exit_code=-1,
                    signal=None,
                    breakpoints=[],
                    has_timeout=False
                )
            
            args = cmd[1:]
            env_dict = self.env or dict(os.environ)
            
            # Use pre-cached adapter
            adapter_cmd, adapter_args = self._adapter_cache
            
            # Prepare fixed stdio files
            self._prepare_stdio_files(stdin_bytes)
            
            # Initialize variables for finally block
            dbg = None
            factory = None
            
            try:
                stdio_commands = [
                    "settings clear target.input-path",
                    "settings clear target.output-path", 
                    "settings clear target.error-path",
                    f"settings set target.output-path {str(self._stdout_path)}",
                    f"settings set target.error-path {str(self._stderr_path)}",
                ]
                if stdin_bytes is not None:
                    stdio_commands.append(f"settings set target.input-path {self._stdin_path}")
                
                launch_args = LaunchRequestArguments(
                    **{
                        "type": "lldb",
                        "request": "launch",
                        "program": program,
                        "args": args,
                        "env": {k: v for k, v in env_dict.items() if isinstance(v, str)},
                        "stopOnEntry": False,
                        "initCommands": [],
                        "preRunCommands": stdio_commands,
                        "noDebug": False,
                        "__restart": None
                    }
                )
                
                # Fast fail: ensure adapter_cmd is not None
                if not adapter_cmd:
                    return RuntimeFeedbackV2(
                        stderr="LLDB adapter command is None",
                        exit_code=-1,
                        signal=None,
                        breakpoints=[],
                        has_timeout=False
                    )
                
                # Fast fail: factory and debugger creation
                try:
                    factory = DAPClientSingletonFactory(adapter_cmd, adapter_args)
                    dbg = Debugger(factory=factory, launch_arguments=launch_args)
                except Exception as e:
                    return RuntimeFeedbackV2(
                        stderr=f"Failed to create debugger: {str(e)}",
                        exit_code=-1,
                        signal=None,
                        breakpoints=[],
                        has_timeout=False
                    )
                
                # Fast fail: initialize() failure
                try:
                    await dbg.initialize()
                except Exception as e:
                    return RuntimeFeedbackV2(
                        stderr=f"Debugger initialization failed: {str(e)}",
                        exit_code=-1,
                        signal=None,
                        breakpoints=[],
                        has_timeout=False
                    )
                
                # Use cached source map
                cache_key = str(Path(program).resolve())
                if cache_key not in self._source_map_cache:
                    if adapter_cmd:
                        self._source_map_cache[cache_key] = _get_source_map(adapter_cmd, program)
                    else:
                        self._source_map_cache[cache_key] = []
                source_map = self._source_map_cache[cache_key]
                
                # Fast breakpoint setup - avoid BreakpointSpec creation
                reports = {}
                id_to_spec = {}
                
                # Branch: with or without breakpoints
                if fast_breakpoints and any(bp_dict.get('location') for bp_dict in fast_breakpoints):
                    # Group breakpoints by file for batch setting
                    breakpoints_by_file = {}
                    for bp_dict in fast_breakpoints:
                        location = bp_dict.get('location', '')
                        if location:
                            file_path, line_no = self._parse_location_fast(location)
                            if file_path not in breakpoints_by_file:
                                breakpoints_by_file[file_path] = []
                            breakpoints_by_file[file_path].append({
                                'location': location,
                                'file_path': file_path,
                                'line_no': line_no,
                                'hit_limit': bp_dict.get('hit_limit', 10),
                                'inline_expr': bp_dict.get('inline_expr', []),
                                'print_call_stack': bp_dict.get('print_call_stack', False)
                            })
                    
                    # Batch set breakpoints by file for better performance
                    for file_path, file_breakpoints in breakpoints_by_file.items():
                        try:
                            # Quick file existence check
                            actual_file_path = file_path
                            if not Path(file_path).exists() and source_map:
                                guesses = [p for p in source_map if p.name == Path(file_path).name]
                                if guesses:
                                    actual_file_path = str(guesses[0])
                            
                            # Set breakpoints for this file in batch
                            for bp_dict in file_breakpoints:
                                try:
                                    resp = await dbg.set_breakpoint(Path(actual_file_path), bp_dict['line_no'])
                                    if (isinstance(resp, SetBreakpointsResponse) and resp.success and 
                                        resp.body.breakpoints and resp.body.breakpoints[-1].id is not None):
                                        
                                        bp_id = resp.body.breakpoints[-1].id
                                        id_to_spec[bp_id] = bp_dict
                                        reports[bp_id] = {
                                            'id': bp_id,
                                            'file_path': actual_file_path,
                                            'line': bp_dict['line_no'],
                                            'function_name': '',
                                            'hit_times': 0,
                                            'hits_info': []
                                        }
                                except Exception:
                                    continue
                        except Exception:
                            continue
                
                # Configuration done after breakpoints are set (or no breakpoints)
                # Note: Some DAP implementations may not require explicit configuration_done
                try:
                    # Try common method names for configuration completion
                    for method_name in ['configuration_done', 'configurationDone', 'send_configuration_done']:
                        if hasattr(dbg, method_name):
                            method = getattr(dbg, method_name)
                            if callable(method):
                                try:
                                    if inspect.iscoroutinefunction(method):
                                        await method()
                                    else:
                                        method()
                                    break
                                except Exception:
                                    continue
                except Exception:
                    # Configuration done is optional for some adapters
                    pass

                # Execution loop with timeout
                start_ts = time.monotonic()
                result_timeout = False
                result_exit_code = None
                result_signal = None
                result_stderr = ""
                
                # Output collection from OutputEvents
                collected_stdout, collected_stderr = [], []
                
                def _get_remaining_timeout():
                    if exec_timeout_sec is None:
                        return None
                    remaining = exec_timeout_sec - (time.monotonic() - start_ts)
                    if remaining <= 0:
                        return 0.0
                    return max(0.05, remaining)
                
                async def _with_timeout(awaitable):
                    remaining = _get_remaining_timeout()
                    if remaining is None:
                        return await awaitable
                    if remaining <= 0.001:
                        raise asyncio.TimeoutError()
                    return await asyncio.wait_for(awaitable, timeout=remaining)
                
                # Fast fail: launch() failure
                try:
                    stopped = await _with_timeout(dbg.launch())
                    if stopped is None:
                        return RuntimeFeedbackV2(
                            stderr="Launch failed: debugger returned None",
                            exit_code=-1,
                            signal=None,
                            breakpoints=[],
                            has_timeout=False
                        )
                except asyncio.TimeoutError:
                    return RuntimeFeedbackV2(
                        stderr="Launch timeout",
                        exit_code=-1,
                        signal=None,
                        breakpoints=[],
                        has_timeout=True
                    )
                except Exception as e:
                    return RuntimeFeedbackV2(
                        stderr=f"Launch failed: {str(e)}",
                        exit_code=-1,
                        signal=None,
                        breakpoints=[],
                        has_timeout=False
                    )
                
                # Fast execution loop - simplified for performance
                while stopped and isinstance(stopped, StoppedDebuggerView) and not result_timeout:
                    # Check timeout before processing
                    remaining = _get_remaining_timeout()
                    if remaining is not None and remaining <= 0.001:
                        result_timeout = True
                        break
                    
                    frames = stopped.frames
                    if not frames:
                        try:
                            stopped = await _with_timeout(dbg.continue_execution())
                        except asyncio.TimeoutError:
                            result_timeout = True
                            break
                        continue
                    
                    # Collect OutputEvents for stdout/stderr
                    if stopped.events and stopped.events.events:
                        for e in stopped.events.events:
                            if isinstance(e, OutputEvent):
                                if hasattr(e.body, 'category') and hasattr(e.body, 'output'):
                                    if e.body.category == "stdout":
                                        collected_stdout.append(e.body.output)
                                    elif e.body.category == "stderr":
                                        collected_stderr.append(e.body.output)
                    
                    # Fast event processing
                    breakpoint_events = [e for e in (stopped.events.events if stopped.events else []) 
                                       if isinstance(e, StoppedEvent) and e.body.reason == "breakpoint"]
                    
                    if not breakpoint_events:
                        exception_events = [e for e in (stopped.events.events if stopped.events else []) 
                                          if isinstance(e, StoppedEvent) and e.body.reason == "exception"]
                        if exception_events:
                            result_signal = exception_events[0].body.description
                            break
                        try:
                            stopped = await _with_timeout(dbg.continue_execution())
                        except asyncio.TimeoutError:
                            result_timeout = True
                            break
                        continue
                    
                    if len(breakpoint_events) >= 1:
                        bp_event = breakpoint_events[0]
                        if (hasattr(bp_event.body, "hitBreakpointIds") and 
                            bp_event.body.hitBreakpointIds is not None):
                            
                            top_frame = frames[0]
                            function_name = frames[0].name if frames else "<unavailable>"
                            
                            for bp_id in bp_event.body.hitBreakpointIds:
                                spec = id_to_spec.get(bp_id)
                                report = reports.get(bp_id)
                                if not spec or not report:
                                    continue
                                
                                report['function_name'] = function_name
                                report['hit_times'] += 1
                                
                                # Remove breakpoint if hit limit reached
                                if report['hit_times'] >= spec['hit_limit']:
                                    try:
                                        await dbg.remove_breakpoint(Path(spec['file_path']), spec['line_no'])
                                    except Exception:
                                        pass
                                
                                # Update location info
                                if top_frame.source and top_frame.source.path:
                                    report['file_path'] = top_frame.source.path
                                report['line'] = top_frame.line
                                
                                # Fast hit info creation
                                hit_info = {
                                    'callstack': _compact_backtrace(frames) if spec['print_call_stack'] else "",
                                    'inline_expr': []
                                }
                                
                                # Inline expression evaluation (if any) - skip if empty
                                inline_exprs = spec.get('inline_expr', [])
                                if inline_exprs:
                                    for var in inline_exprs:
                                        try:
                                            ev = await dbg.evaluate(var)
                                            if isinstance(ev, ErrorResponse):
                                                val = f"<error: debugger need a valid variable name:{var}. How to fix: 1. search for the variable definition 2. if (1) fails, set the breakpoint at a different line>"
                                            else:
                                                try:
                                                    # Handle both ErrorResponse and successful evaluation response
                                                    success = getattr(ev, "success", False)
                                                    body = getattr(ev, "body", None)
                                                    if success and body and hasattr(body, "result"):
                                                        val = str(body.result)
                                                    else:
                                                        val = "<no_result>"
                                                except:
                                                    val = f"<error: debugger need a valid variable name: {var}. How to fix: 1. search for the variable definition 2. if (1) fails, set the breakpoint at a different line>"
                                        except Exception:
                                            val = "<unavailable>"
                                        
                                        hit_info['inline_expr'].append({'name': var, 'value': val})
                                
                                # Avoid duplicate hit_info (simple comparison)
                                if hit_info not in report['hits_info']:
                                    report['hits_info'].append(hit_info)
                    
                    # Final timeout check before continue
                    remaining = _get_remaining_timeout()
                    if remaining is not None and remaining <= 0.001:
                        result_timeout = True
                        break
                    
                    try:
                        stopped = await _with_timeout(dbg.continue_execution())
                    except asyncio.TimeoutError:
                        result_timeout = True
                        break
                
                # Check for exit events
                if isinstance(stopped, EventListView) and stopped.events:
                    exited_events = [e for e in stopped.events if isinstance(e, ExitedEvent)]
                    if exited_events and isinstance(exited_events[0], ExitedEvent):
                        result_exit_code = exited_events[0].body.exitCode

                # Fallback Read output files with OutputEvent fallback
                output_event_stderr = "".join(collected_stderr)
                if not output_event_stderr:
                    try:
                        with open(self._stderr_path, "rb") as f:
                            output_event_stderr = f.read().decode(errors="replace")
                    except Exception:
                        output_event_stderr = ""
                
                # Prefer OutputEvent stderr, fallback to file stderr
                result_stderr = output_event_stderr
                
                # Convert reports to BreakpointReport format for compatibility
                breakpoint_reports = []
                for report in reports.values():
                    # Convert dict-based hits_info to BreakpointHitInfo format
                    hits_info_converted = []
                    for hit in report['hits_info']:
                        inline_expr_converted = [InlineExprValue(name=expr['name'], value=expr['value']) 
                                               for expr in hit.get('inline_expr', [])]
                        hits_info_converted.append(BreakpointHitInfo(
                            callstack=hit.get('callstack', ''),
                            inline_expr=inline_expr_converted
                        ))
                    
                    breakpoint_reports.append(BreakpointReport(
                        id=report['id'],
                        file_path=report['file_path'],
                        line=report['line'],
                        function_name=report['function_name'],
                        hit_times=report['hit_times'],
                        hits_info=hits_info_converted
                    ))
                
                return RuntimeFeedbackV2(
                    stderr=result_stderr,
                    exit_code=result_exit_code,
                    signal=result_signal,
                    breakpoints=breakpoint_reports,
                    has_timeout=result_timeout
                )
                
            finally:
                # 1) Graceful disconnect, asking the adapter to kill the debugged program
                if dbg:
                    for name in ("disconnect", "Disconnect", "send_disconnect"):
                        fn = getattr(dbg, name, None)
                        if not callable(fn):
                            continue
                        try:
                            result = fn({"terminateDebuggee": True})
                            if inspect.isawaitable(result):
                                await asyncio.wait_for(result, timeout=0.25)
                        except Exception:
                            pass
                        break

                    # 2) terminate() (short timeout)
                    try:
                        await asyncio.wait_for(dbg.terminate(), timeout=0.5)
                    except Exception:
                        pass

                # 3) Fallback: kill the adapter process tree
                for pid in (
                    getattr(dbg, "pid", None),
                    getattr(getattr(dbg, "_adapter", None), "pid", None),
                    getattr(factory, "pid", None),
                    getattr(getattr(factory, "process", None), "pid", None),
                ):
                    if not pid:
                        continue
                    try:
                        self._kill_tree(pid, term_timeout=0.2)
                    except Exception:
                        pass

                # 4) close factory
                close_method = getattr(factory, "close", None)
                if callable(close_method):
                    try:
                        close_method()
                    except Exception:
                        pass

        def run(self, cmd: List[str], stdin: Optional[bytes] = None, exec_timeout_sec: Optional[int] = None,
               breakpoints: Optional[List[Dict[str, Any]]] = None) -> RuntimeFeedbackV2:
            """Synchronous run method for backward compatibility."""
            return self.run_sync(cmd, stdin, exec_timeout_sec, breakpoints)

        # Old low-performance run_async method removed - use run_sync instead

        def _parse_location_fast(self, location: str) -> tuple[str, int]:
            """Fast cached location parsing to avoid repeated string splits."""
            if location not in self._location_cache:
                try:
                    fp, ln = location.rsplit(":", 1)
                    self._location_cache[location] = (fp, int(ln))
                except:
                    self._location_cache[location] = ('', 0)
            return self._location_cache[location]
        
        def run_sync(self, cmd: List[str], stdin: Optional[bytes] = None, exec_timeout_sec: Optional[int] = None,
                    breakpoints: Optional[List[Dict[str, Any]]] = None) -> RuntimeFeedbackV2:
            """Optimized high-performance run_sync - handles event loop conflicts."""
            
            # Fast path: avoid Pydantic BreakpointSpec creation
            fast_breakpoints = []
            if breakpoints:
                for bp_dict in breakpoints:
                    location = bp_dict.get('location', '')
                    if location:
                        file_path, line_no = self._parse_location_fast(location)
                        fast_breakpoints.append({
                            'location': location,
                            'file_path': file_path,
                            'line_no': line_no,
                            'hit_limit': bp_dict.get('hit_limit', 10),
                            'inline_expr': bp_dict.get('inline_expr', []),
                            'print_call_stack': bp_dict.get('print_call_stack', False)
                        })
            
            # Handle event loop conflicts safely
            def run_in_new_thread():
                """Run in a separate thread to avoid event loop conflicts."""
                new_loop = asyncio.new_event_loop()
                asyncio.set_event_loop(new_loop)
                try:
                    return new_loop.run_until_complete(
                        self._run_dap(cmd, stdin, fast_breakpoints, float(exec_timeout_sec) if exec_timeout_sec else None)
                    )
                finally:
                    # Fast cleanup
                    try:
                        pending = asyncio.all_tasks(new_loop)
                        for task in pending:
                            if not task.done():
                                task.cancel()
                        new_loop.close()
                    except Exception:
                        pass
            
            try:
                # Try to get the current running loop
                current_loop = asyncio.get_running_loop()
                # If we get here, there's already a loop running
                # Use the reusable thread pool to avoid conflicts
                if self._executor is not None:
                    future = self._executor.submit(run_in_new_thread)
                    timeout = (exec_timeout_sec or 30) + 5
                    return future.result(timeout=timeout)
                else:
                    # Fallback if executor is None
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                        future = executor.submit(run_in_new_thread)
                        timeout = (exec_timeout_sec or 30) + 5
                        return future.result(timeout=timeout)
            except RuntimeError:
                # No event loop is currently running, safe to use asyncio.run
                return asyncio.run(
                    self._run_dap(cmd, stdin, fast_breakpoints, float(exec_timeout_sec) if exec_timeout_sec else None)
                )

        def run_dict(self, cmd: List[str], stdin: Optional[bytes] = None, exec_timeout_sec: Optional[int] = None,
                    breakpoints: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
            """High-performance run_dict using optimized run_sync."""
            result = self.run_sync(cmd, stdin, exec_timeout_sec, breakpoints)
            return result.model_dump()
        
        def run_dict_sync(self, cmd: List[str], stdin: Optional[bytes] = None, exec_timeout_sec: Optional[int] = None,
                         breakpoints: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
            result = self.run_sync(cmd, stdin, exec_timeout_sec, breakpoints)
            return result.model_dump()

        def close(self, timeout: float = 1.0):
            """Gracefully destroy resources."""
            # Shutdown thread pool
            try:
                executor = getattr(self, "_executor", None)
                if executor is not None:
                    executor.shutdown(wait=True, cancel_futures=True)
            except Exception:
                pass
            self._executor = None
            
            # Delete fixed stdio files
            for p in (getattr(self, "_stdout_path", None),
                      getattr(self, "_stderr_path", None),
                      getattr(self, "_stdin_path", None)):
                try:
                    if p:
                        os.unlink(p)
                except Exception:
                    pass
            # kill all lldb processes
            try:
                for proc in psutil.process_iter(['pid', 'name']):
                    try:
                        if proc.info['name'] and "lldb" in proc.info['name']:
                            proc.kill()
                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                        continue
            except Exception as e:
                pass

except ImportError as e:
    print(f"Warning: Missing dependencies for DAP debugging: {e}")