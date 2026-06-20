#!/usr/bin/env python3
"""
MCP (Model Context Protocol) Server for Corpus Management

This server manages a corpus of testcases and provides reaching routes to LLM agents.
It processes initial seed directories in the background and maintains a queue of testcases
that can reach the target location. For each reaching testcase, it runs debugger analysis
to extract callstack routes and maintains the smallest input for each route.

Available tools:
- get_reaching_routes: Get reaching routes with their associated testcases
- get_corpus_status: Get current corpus processing status
- extract_parameters: Extract parameter space from reaching route testcases using custom extractor code
"""

import asyncio
import argparse
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import importlib.util
import json
from pathlib import Path
from queue import Queue, Empty
from typing import Any, Dict, List, Optional

import utils
from utils import read_workflow_state, check_tool_permission

try:
    import mcp.server.stdio
    import mcp.types as types
    from mcp.server import Server
except ImportError:
    print("Error: MCP package not installed. Please run: pip install mcp", file=sys.stderr)
    sys.exit(1)

from config import Config
from source_code import SourceCodeFinder
from debugger import RuntimeDebugger
from schemas import WorkflowPhase


class Corpus:
    """Manages a corpus of testcases with a seed queue for reaching testcases and route analysis."""
    
    def __init__(self, input_dir: str, output_dir: str, cmd_template: str, reached_pattern: str, static_result_folder: str):
        """Initialize corpus with configuration.
        
        Args:
            input_dir: Directory containing initial seed testcases
            output_dir: Output directory for processed testcases
            cmd_template: Command template for executing target program
            reached_pattern: Regex pattern to detect target reached
            static_result_folder: Path to static analysis results
        """
        self.input_dir = Path(input_dir)
        self.output_dir = Path(output_dir)
        self.cmd_template = cmd_template
        self.reached_pattern = re.compile(reached_pattern)
        self.static_result_folder = static_result_folder
        
        # Create queue directory
        self.queue_dir = self.output_dir / "queue"
        self.queue_dir.mkdir(parents=True, exist_ok=True)
        
        # Thread-safe queue for reaching testcases
        self.seed_queue = Queue()
        
        # New: possible_routes data structure - callstack -> input filepath
        # Key: full callstack string, Value: input filepath (smallest file)
        self.possible_routes = {}
        self._routes_lock = threading.Lock()
        
        # Lock for statistics to prevent race conditions
        self._stats_lock = threading.Lock()
        
        # Processing state
        self.processing_complete = False
        self.reaching_seed_scanning_complete = False
        self.processing_thread = None
        
        # Single consumer thread for debugger analysis
        self.consumer_thread = None
        
        # Statistics
        self.total_processed = 0
        self.reaching_found = 0
        self.routes_analyzed = 0
        self.failed_route_analysis = 0
        
        self.logger = logging.getLogger(self.__class__.__name__)
        
        # Error logging setup
        self.error_log_file = self.output_dir / "corpus_errors.log"
        
        # Initialize components for target location analysis
        self._init_analysis_components()
    
    @property
    def debugger(self) -> RuntimeDebugger:
        if self._debugger is None:
            self._debugger = RuntimeDebugger(self.config)
        return self._debugger

    def _maybe_mark_complete(self):
        """Helper to mark processing complete only when all work is truly done.
        
        Conditions for completion:
        1. Seed scanning is complete, AND
        2. Either queue is empty OR no consumer thread was started (no target locations)
        
        This prevents premature completion signaling and ensures processing_complete
        is only True when all work is finished.
        """
        if self.reaching_seed_scanning_complete:
            # If no consumer thread, we're done when scan completes
            if not self.consumer_thread:
                self.processing_complete = True
            # If consumer thread exists, we're done when queue is empty
            elif self.seed_queue.empty():
                self.processing_complete = True

    def _log_error_to_file(self, message: str, stage: str = "unknown") -> None:
        """
        Log error/warning messages to error.log file for later retrieval by agent.
        
        Args:
            message: Error message to log
            stage: Stage where error occurred (e.g., 'initialization', 'execution', etc.)
        """
        utils.log_error_to_file(self.error_log_file, message, stage, "corpus_server", self.logger)

    def _init_analysis_components(self):
        """Initialize components needed for debugger analysis."""
        try:
            # Create config object for accessing static analysis results
            self.config = Config()
            self.config.static_result_folder = Path(self.static_result_folder)
            self.config.cmd = self.cmd_template.split()
            
            # Initialize source code finder to get target locations
            self.source_finder = SourceCodeFinder(self.config)
            
            # Get target locations from BBtargets.txt
            self.target_locations = self._collect_target_locations()
            
            # Initialize debugger
            self._debugger = None
            
            self.logger.info(f"Initialized analysis components with {len(self.target_locations)} target locations")
            
        except Exception as e:
            self._log_error_to_file(f"Failed to initialize analysis components: {e}", "initialization")
            self.target_locations = []

    def _collect_target_locations(self) -> List[str]:
        """
        Collect target locations from BBtargets.txt and convert to debugger format.
        Uses SourceCodeFinder to resolve correct file paths from static analysis results.
        
        Returns:
            List of target location strings in format "absolute_filepath:line"
        """
        target_locations = []
        bb_targets_file = os.path.join(self.static_result_folder, "BBtargets.txt")
        
        try:
            with open(bb_targets_file, 'r') as f:
                for line in f:
                    loc = line.strip()
                    if not loc or ':' not in loc:
                        continue
                    # Convert relative path to absolute path for debugger
                    file_part, line_part = loc.rsplit(':', 1)
                    has_found_abs_path = False
                    # First try: check if it's already absolute
                    if os.path.isabs(file_part) and os.path.exists(file_part):
                        target_locations.append(f"{file_part}:{line_part}")
                        has_found_abs_path = True
                    else:
                        # Use SourceCodeFinder to get correct file paths
                        # First try to get function GUIDs for this location
                        fn_guids = self.source_finder.get_func_ids_from_loc(loc)
                        
                        if fn_guids:
                            # Get the file path from the first matching function
                            file_path = self.source_finder.get_fp_from_func_id(fn_guids[0])
                            if file_path and os.path.exists(file_path):
                                target_locations.append(f"{file_path}:{line_part}")
                                has_found_abs_path = True
                        # Fallback: try filename mapping from SourceCodeFinder
                        if not has_found_abs_path:
                            filename = os.path.basename(file_part)
                            if filename in self.source_finder.fp_fn_map:
                                filepaths = self.source_finder.fp_fn_map[filename]
                                for filepath in filepaths:
                                    if os.path.exists(filepath):
                                        target_locations.append(f"{filepath}:{line_part}")
                                        has_found_abs_path = True
                    if not has_found_abs_path:
                        self._log_error_to_file(f"Could not find source file for {file_part} (location: {loc})", "initialization")
                            
        except Exception as e:
            self._log_error_to_file(f"Failed to read BBtargets.txt: {e}", "initialization")
        if not target_locations:
            self._log_error_to_file(f"No target locations found", "initialization")
        return target_locations
        
    def start_processing(self):
        """Start background thread to process initial seed directory and consumer thread."""
        if self.processing_thread is not None:
            self.logger.warning("Processing thread already started")
            return
        
        # Start consumer thread for route analysis
        if self.target_locations:
            self.consumer_thread = threading.Thread(
                target=self._consumer_worker,
                daemon=True
            )
            self.consumer_thread.start()
            self.logger.info("Started background processing of seed directory and consumer thread")
        else:
            self._log_error_to_file("No target locations found, skipping consumer thread", "initialization")
            self.logger.info("Started background processing of seed directory only")

        self.processing_thread = threading.Thread(
            target=self._process_seeds_background,
            daemon=True
        )
        self.processing_thread.start()

    def _consumer_worker(self):
        """Consumer thread worker that processes reaching testcases with debugger."""
        self.logger.info("Consumer worker started")
        try:
            while True:
                try:
                    testcase_path = self.seed_queue.get(timeout=1.0)
                except Empty:
                    if self.reaching_seed_scanning_complete and self.seed_queue.empty():
                        break
                    continue

                try:
                    if testcase_path is None:  # shutdown signal
                        break

                    self.logger.debug(f"Consumer processing testcase: {testcase_path}")
                    success, error_type = self._analyze_testcase_routes(testcase_path)

                    with self._stats_lock:
                        if success:
                            self.routes_analyzed += 1
                        else:
                            self.failed_route_analysis += 1

                    if not success:
                        if error_type == "debugger_error":
                            self._log_error_to_file(
                                f"Critical error ({error_type}) analyzing {testcase_path}",
                                "route_analysis"
                            )
                            break
                        self._log_error_to_file(
                            f"Non-critical error ({error_type}) analyzing {testcase_path}",
                            "route_analysis"
                        )
                        continue

                except Exception as e:
                    self._log_error_to_file(
                        f"Consumer worker encountered error: {e}",
                        "route_analysis"
                    )
                    time.sleep(0.1)
            self._maybe_mark_complete()

        finally:
            if self._debugger:
                self._debugger.close()
                self._debugger = None

    def _analyze_testcase_routes(self, testcase_path: str) -> tuple[bool, str]:
        """
        Analyze a testcase with debugger to extract callstack routes.
        
        Args:
            testcase_path: Path to the testcase file
            
        Returns:
            tuple: (success: bool, error_type: str)
                   error_type can be: "success", "no_breakpoints", "debugger_error", "file_error"
        """
        try:
            # Read testcase content
            try:
                with open(testcase_path, "rb") as f:
                    file_content = f.read()
            except (IOError, OSError) as e:
                self._log_error_to_file(f"Failed to read testcase {testcase_path}: {e}", "route_analysis")
                return False, "file_error"
            
            # Prepare breakpoints for target locations
            breakpoints = []
            for target_loc in self.target_locations:
                breakpoint = {
                    "location": target_loc,
                    "hit_limit": 10,
                    "inline_expr": [],
                    "print_call_stack": True  # Essential for route extraction
                }
                breakpoints.append(breakpoint)
            
            # Prepare command and stdin data
            cmd_args, stdin_data = utils.prepare_cmd_and_stdin(
                self.cmd_template, testcase_path, file_content
            )
            
            # Run with debugger - this is the critical section that can fail
            try:
                result = self.debugger.run_sync(
                    cmd=cmd_args,
                    stdin=stdin_data,
                    exec_timeout_sec=5,  # Reasonable timeout for analysis
                    breakpoints=breakpoints
                )
            except Exception as e:
                # Debugger errors are critical - should terminate consumer
                self._log_error_to_file(f"Debugger error for {testcase_path}: {e}", "route_analysis")
                return False, "debugger_error"
            
            # Check if any breakpoints were hit
            hit_breakpoints = [bp for bp in result.breakpoints if bp.hit_times > 0]
            
            if not hit_breakpoints:
                # No breakpoints hit - this is expected for non-reaching testcases
                # But should terminate consumer as it indicates the testcase doesn't actually reach target
                self._log_error_to_file(f"No breakpoints hit for {testcase_path} - testcase may not reach target", "route_analysis")
                return False, "no_breakpoints"
            
            # Extract callstack routes
            routes_extracted = 0
            for bp in hit_breakpoints:
                if bp.hits_info:
                    for hit_info in bp.hits_info:
                        if hasattr(hit_info, 'callstack') and hit_info.callstack:
                            callstack = hit_info.callstack.strip()
                            if not callstack:
                                continue
                            callstack_lines = callstack.strip().split('\n')
                            if len(callstack_lines) > 5:
                                callstack_lines_truncated = callstack_lines[:5]
                                callstack = '\n'.join(callstack_lines_truncated) + f"\n... ({len(callstack_lines) - 5} more frames)"
                            else:
                                callstack = '\n'.join(callstack_lines)
                            self._update_possible_routes(callstack, testcase_path)
                            routes_extracted += 1
            
            if routes_extracted > 0:
                self.logger.debug(f"Successfully analyzed {testcase_path}, extracted {routes_extracted} routes")
                return True, "success"
            else:
                self._log_error_to_file(f"No valid callstacks extracted from {testcase_path}", "route_analysis")
                return False, "no_callstacks"
            
        except Exception as e:
            # Unexpected errors should terminate consumer
            self._log_error_to_file(f"Unexpected error analyzing testcase {testcase_path}: {e}", "route_analysis")
            return False, "unexpected_error"

    def _update_possible_routes(self, callstack: str, testcase_path: str):
        """
        Update possible_routes with new callstack information.
        Keep only the smallest input file for each callstack.
        
        Args:
            callstack: Full callstack string
            testcase_path: Path to the testcase that produced this callstack
        """
        try:
            testcase_size = os.path.getsize(testcase_path)
            
            with self._routes_lock:
                if callstack in self.possible_routes:
                    # Check if current testcase is smaller
                    existing_path = self.possible_routes[callstack]
                    if os.path.exists(existing_path):
                        existing_size = os.path.getsize(existing_path)
                        if testcase_size < existing_size:
                            self.possible_routes[callstack] = testcase_path
                            self.logger.debug(f"Updated route for callstack (smaller input: {testcase_size} < {existing_size})")
                    else:
                        # Existing file doesn't exist anymore, replace it
                        self.possible_routes[callstack] = testcase_path
                        self.logger.debug(f"Replaced missing file for callstack route")
                else:
                    # New callstack, add it
                    self.possible_routes[callstack] = testcase_path
                    self.logger.info(f"Added new route: {len(callstack[:100])}... -> {os.path.basename(testcase_path)}")
                    
        except Exception as e:
            self._log_error_to_file(f"Error updating possible routes: {e}", "route_analysis")
        
    def _process_seeds_background(self):
        """Background thread function to process all seeds in input directory."""
        try:
            if not self.input_dir.exists():
                self._log_error_to_file(f"Input directory does not exist: {self.input_dir}", "seed_processing")
                self.reaching_seed_scanning_complete = True
                return
                
            # Find all testcase files in input directory
            testcase_files = []
            for root, dirs, files in os.walk(self.input_dir):
                for file in files:
                    file_path = Path(root) / file
                    # Skip hidden files and directories
                    if not file.startswith('.') and file_path.is_file():
                        testcase_files.append(file_path)
            
            self.logger.info(f"Found {len(testcase_files)} testcases to process")
            
            for testcase_path in testcase_files:
                try:
                    self._process_single_testcase(testcase_path)
                    with self._stats_lock:
                        self.total_processed += 1
                except Exception as e:
                    self._log_error_to_file(f"Error processing {testcase_path}: {e}", "seed_processing")
            
            # Read statistics with lock for logging
            with self._stats_lock:
                total = self.total_processed
                found = self.reaching_found
            self.logger.info(f"Scanning complete. Processed {total} testcases, found {found} reaching testcases")
            
            self.reaching_seed_scanning_complete = True
            
            self._maybe_mark_complete()
                           
        except Exception as e:
            self._log_error_to_file(f"Background processing failed: {e}", "seed_processing")
            self.reaching_seed_scanning_complete = True
            self._maybe_mark_complete()
            
    def _process_single_testcase(self, testcase_path: Path):
        """Process a single testcase to check if it reaches the target.
        
        Args:
            testcase_path: Path to the testcase file
        """
        try:
            # Read testcase content
            with open(testcase_path, "rb") as f:
                file_content = f.read()
                
            # Prepare command and stdin data
            cmd_args, stdin_data = utils.prepare_cmd_and_stdin(
                self.cmd_template, str(testcase_path), file_content
            )
            
            # Execute the testcase
            try:
                proc = subprocess.run(
                    cmd_args,
                    input=stdin_data,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    cwd=str(self.output_dir),
                    timeout=3
                )
                stderr = proc.stderr.decode("utf-8", errors="replace")
                
                # Check if target was reached
                if self._check_reached(stderr):
                    self._add_reaching_testcase(testcase_path)
                    
            except subprocess.TimeoutExpired:
                self.logger.debug(f"Testcase {testcase_path.name} timed out")
            except Exception as e:
                self.logger.debug(f"Error executing testcase {testcase_path.name}: {e}")
                
        except Exception as e:
            self._log_error_to_file(f"Error processing testcase {testcase_path}: {e}", "seed_processing")
            
    def _check_reached(self, stderr: str) -> bool:
        """Check if the target was reached based on stderr output.
        
        Args:
            stderr: Standard error output from program execution
            
        Returns:
            bool: True if target was reached
        """
        return bool(self.reached_pattern.search(stderr))
        
    def _add_reaching_testcase(self, testcase_path: Path):
        """Add a reaching testcase to the queue.
        
        Args:
            testcase_path: Path to the reaching testcase
        """
        try:
            # Generate filename with current counter (need to lock to prevent race condition)
            with self._stats_lock:
                queue_filename = f"reaching_{self.reaching_found:06d}_{testcase_path.name}"
                self.reaching_found += 1
            
            queue_path = self.queue_dir / queue_filename
            
            shutil.copy2(testcase_path, queue_path)
            
            # Add to queue
            self.seed_queue.put(str(queue_path.absolute()))
            
            self.logger.info(f"Added reaching testcase: {queue_filename}")
            
        except Exception as e:
            self._log_error_to_file(f"Error adding reaching testcase {testcase_path}: {e}", "seed_processing")
    
    def peek_reaching_testcase(self) -> Optional[str]:
        """Peek at a reaching testcase without removing it from the queue.
        
        This is safe for status/display purposes and won't interfere with consumer thread.
        
        Returns:
            str: Absolute path to reaching testcase, or None if queue is empty
        """
        with self.seed_queue.mutex:
            return self.seed_queue.queue[0] if self.seed_queue.queue else None
            
    def get_status(self) -> Dict[str, Any]:
        """Get current corpus status.
        
        Returns:
            Dict containing status information
        """
        # Get route count with routes lock
        with self._routes_lock:
            routes_count = len(self.possible_routes)
        
        # Get statistics with stats lock
        with self._stats_lock:
            stats = {
                "total_processed": self.total_processed,
                "reaching_found": self.reaching_found,
                "routes_analyzed": self.routes_analyzed,
                "failed_route_analysis": self.failed_route_analysis,
            }
        
        # Combine with unlocked data
        return {
            "processing_complete": self.processing_complete,  # boolean access is atomic
            "queue_size": self.seed_queue.qsize(),  # Queue is thread-safe
            "possible_routes_count": routes_count,
            "target_locations_count": len(self.target_locations) if hasattr(self, 'target_locations') else 0,
            **stats
        }

    def get_possible_routes(self) -> Dict[str, str]:
        """Get copy of possible routes data.
        
        Returns:
            Dict mapping callstack strings to testcase file paths
        """
        with self._routes_lock:
            return self.possible_routes.copy()
            
    def _inject_common_imports(self, extractor_code: str) -> str:
        """
        Pre-inject common imports at the beginning of extractor code.
        This avoids costly error handling during module loading.
        
        Args:
            extractor_code: Original extractor code
            
        Returns:
            Extractor code with common imports added
        """
        # Most commonly used imports that should always be available
        common_imports = [
            "import random",
            "import struct", 
            "import os",
            "import sys",
            "import re",
            "import string",
            "from typing import Dict, List, Any, Optional, Callable, Tuple, Union",
            "from collections import defaultdict, Counter, deque",
            "import json",
            "import math",
            "from pathlib import Path"
        ]
        
        # Use unified import insertion logic
        result_code = extractor_code
        for import_stmt in common_imports:
            if not self._is_import_already_present(result_code, self._extract_import_name(import_stmt), import_stmt):
                result_code = self._insert_import_at_position(result_code, import_stmt)
        
        return result_code
    
    def _extract_import_name(self, import_statement: str) -> str:
        """
        Extract the main name being imported from an import statement.
        
        Args:
            import_statement: Import statement like "import random" or "from typing import Dict"
            
        Returns:
            The main name being imported
        """
        
        # Handle "import module" or "import module as alias"
        if import_statement.strip().startswith('import '):
            match = re.search(r'import\s+(\w+)', import_statement)
            return match.group(1) if match else 'unknown'
        
        # Handle "from module import name1, name2" - return first name
        elif import_statement.strip().startswith('from '):
            match = re.search(r'from\s+\w+\s+import\s+(\w+)', import_statement)
            return match.group(1) if match else 'unknown'
        
        return 'unknown'
    
    def _insert_import_at_position(self, content: str, import_statement: str) -> str:
        """
        Insert import statement at the optimal position in the code.
        
        Args:
            content: Original file content
            import_statement: The import statement to add
            
        Returns:
            Modified content with import added
        """
        lines = content.split('\n')
        
        # Find the best position to insert the import
        insert_pos = self._find_best_import_position(lines, import_statement)
        
        # Insert the import statement
        lines.insert(insert_pos, import_statement)
        
        return '\n'.join(lines)
    
    def _find_best_import_position(self, lines: list, import_statement: str) -> int:
        """
        Find the best position to insert an import statement.
        
        Args:
            lines: List of file lines
            import_statement: The import statement to insert
            
        Returns:
            Position index where to insert the import
        """
        # Categorize import types for better organization
        is_stdlib_import = any(module in import_statement for module in [
            'import os', 'import sys', 'import json', 'import time', 'import math',
            'import random', 'import string', 'import itertools', 'import collections',
            'import functools', 'import datetime', 'import copy', 'import pickle',
            'import csv', 'import sqlite3', 'import logging', 'import argparse',
            'import subprocess', 'import threading', 'import multiprocessing',
            'import re', 'import struct', 'import hashlib', 'import base64'
        ])
        
        is_from_import = import_statement.strip().startswith('from ')
        is_typing_import = 'typing' in import_statement
        
        # Track different import sections
        last_stdlib_import = -1
        last_from_import = -1
        last_typing_import = -1
        last_import_line = -1
        
        # Scan existing imports to find appropriate sections
        for i, line in enumerate(lines):
            stripped = line.strip()
            if not stripped or stripped.startswith('#'):
                continue
            
            if stripped.startswith('import ') or stripped.startswith('from '):
                last_import_line = i
                
                if 'typing' in stripped:
                    last_typing_import = i
                elif stripped.startswith('from '):
                    last_from_import = i
                else:
                    last_stdlib_import = i
            elif stripped and not stripped.startswith('#'):
                # Found first non-import, non-comment line
                break
        
        # Determine insertion position based on import type
        if is_typing_import and last_typing_import >= 0:
            return last_typing_import + 1
        elif is_from_import and last_from_import >= 0:
            return last_from_import + 1
        elif is_stdlib_import and last_stdlib_import >= 0:
            return last_stdlib_import + 1
        elif last_import_line >= 0:
            return last_import_line + 1
        else:
            # No existing imports, insert at the beginning (after shebang/encoding if present)
            insert_pos = 0
            for i, line in enumerate(lines):
                stripped = line.strip()
                if stripped.startswith('#!') or 'coding:' in stripped or 'encoding:' in stripped:
                    insert_pos = i + 1
                elif stripped:
                    break
            return insert_pos

    def _is_import_already_present(self, content: str, undefined_name: str, import_statement: str) -> bool:
        """
        Check if an import is already present in the file content.
        
        Args:
            content: File content to check
            undefined_name: The name that was undefined
            import_statement: The import statement to add
            
        Returns:
            True if import is already present, False otherwise
        """
        
        # Direct match - exact import statement already exists
        if import_statement in content:
            return True
        
        # Special handling for typing imports
        typing_names = {'Dict', 'Any', 'Tuple', 'List', 'Optional', 'Union', 'Set', 
                       'Callable', 'Iterator', 'Iterable', 'Generator', 'Type', 
                       'ClassVar', 'Final', 'Literal', 'TypeVar', 'Generic', 'Protocol', 'typing'}
        
        if undefined_name in typing_names:
            # Check if any typing import exists
            if re.search(r'from typing import', content):
                # Check if the specific type is already imported
                pattern = rf'from typing import[^\n]*\b{re.escape(undefined_name)}\b'
                if re.search(pattern, content):
                    return True
                # If not, we'll need to merge with existing typing import
                return False
            return False
        
        # Special handling for collections imports
        collections_names = {'namedtuple', 'defaultdict', 'Counter', 'OrderedDict', 'deque', 'ChainMap'}
        if undefined_name in collections_names:
            pattern = rf'from collections import[^\n]*\b{re.escape(undefined_name)}\b'
            if re.search(pattern, content):
                return True
        
        # Check for module alias imports (e.g., 'np' for numpy)
        alias_patterns = {
            'np': r'import numpy as np',
            'pd': r'import pandas as pd',
        }
        
        if undefined_name in alias_patterns:
            if re.search(alias_patterns[undefined_name], content):
                return True
        
        # Check for module imports that could satisfy the undefined name
        module_patterns = {
            'Path': r'from pathlib import Path',
        }
        
        if undefined_name in module_patterns:
            if re.search(module_patterns[undefined_name], content):
                return True
        
        return False
    
    def _load_dynamic_extractor(self, extractor_code: str):
        """
        Dynamically load extractor function from code string.
        
        Args:
            extractor_code: Python code containing extract_parameters function
            
        Returns:
            Extractor function if found and valid
            
        Raises:
            Exception: If extractor cannot be imported or is invalid
        """
        try:
            # Create unique module name to avoid caching issues
            module_name = f"extractor_{int(time.time() * 1000000)}"
            
            # Create a temporary file for the extractor code
            extractor_file = self.output_dir / "feature_extractor.py"
            
            # Pre-inject common imports
            enhanced_code = self._inject_common_imports(extractor_code)
            
            with open(extractor_file, "w") as f:
                f.write(enhanced_code)
            
            # Load module dynamically
            spec = importlib.util.spec_from_file_location(module_name, extractor_file)
            if spec is None or spec.loader is None:
                raise Exception(f"Failed to create module spec for extractor")
            
            module = importlib.util.module_from_spec(spec)
            
            # Execute module
            try:
                spec.loader.exec_module(module)
            except NameError as ne:
                self._log_error_to_file(f"NameError in extractor: {ne}", "extractor_import")
                raise Exception(f"Missing imports in extractor: {ne}")
            
            # Check if extract_parameters function exists
            if not hasattr(module, 'extract_parameters'):
                raise Exception(f"No 'extract_parameters' function found in extractor code")
            
            extract_func = getattr(module, 'extract_parameters')
            
            # Basic validation - check if it's callable
            if not callable(extract_func):
                raise Exception(f"'extract_parameters' is not callable")
            
            self.logger.debug(f"Successfully loaded extractor function")
            
            # Clean up temporary file
            try:
                extractor_file.unlink()
            except:
                pass  # Ignore cleanup errors
            
            return extract_func
            
        except Exception as e:
            # Clean up temporary file on error
            try:
                extractor_file_path = self.output_dir / "feature_extractor.py"
                if extractor_file_path.exists():
                    extractor_file_path.unlink()
            except:
                pass
            raise Exception(f"Error loading extractor: {str(e)}")
    
    def _merge_parameter_spaces(self, param_spaces: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Merge multiple parameter spaces into a unified parameter space.
        
        Args:
            param_spaces: List of parameter space dictionaries
            
        Returns:
            Merged parameter space dictionary
        """
        merged = {}
        
        for param_space in param_spaces:
            if not isinstance(param_space, dict):
                continue
                
            for param_name, param_spec in param_space.items():
                if not isinstance(param_spec, dict) or 'type' not in param_spec:
                    continue
                
                param_type = param_spec['type']
                
                if param_name not in merged:
                    # First occurrence of this parameter
                    merged[param_name] = param_spec.copy()
                else:
                    # Merge with existing parameter
                    existing_spec = merged[param_name]
                    existing_type = existing_spec.get('type')
                    
                    if existing_type == param_type:
                        # Same type, merge ranges/values
                        if param_type == 'int_range':
                            merged[param_name]['min'] = min(
                                existing_spec.get('min', 0), 
                                param_spec.get('min', 0)
                            )
                            merged[param_name]['max'] = max(
                                existing_spec.get('max', 100), 
                                param_spec.get('max', 100)
                            )
                        elif param_type == 'float_range':
                            merged[param_name]['min'] = min(
                                existing_spec.get('min', 0.0), 
                                param_spec.get('min', 0.0)
                            )
                            merged[param_name]['max'] = max(
                                existing_spec.get('max', 1.0), 
                                param_spec.get('max', 1.0)
                            )
                        elif param_type == 'categorical':
                            # Merge categorical values
                            existing_values = set(existing_spec.get('values', []))
                            new_values = set(param_spec.get('values', []))
                            merged[param_name]['values'] = list(existing_values.union(new_values))
                    else:
                        # Different types, keep the more general one or convert to categorical
                        if existing_type == 'bool' and param_type in ['int_range', 'categorical']:
                            merged[param_name] = param_spec.copy()
                        elif param_type == 'bool' and existing_type in ['int_range', 'categorical']:
                            # Keep existing
                            pass
                        else:
                            # Convert to categorical with representative values
                            merged[param_name] = {
                                'type': 'categorical',
                                'values': self._get_representative_values(existing_spec) + 
                                         self._get_representative_values(param_spec)
                            }
        
        return merged
    
    def _get_representative_values(self, param_spec: Dict[str, Any]) -> List[Any]:
        """
        Get representative values from a parameter specification.
        
        Args:
            param_spec: Parameter specification dictionary
            
        Returns:
            List of representative values
        """
        param_type = param_spec.get('type')
        
        if param_type == 'int_range':
            min_val = param_spec.get('min', 0)
            max_val = param_spec.get('max', 100)
            return [min_val, max_val, (min_val + max_val) // 2]
        elif param_type == 'float_range':
            min_val = param_spec.get('min', 0.0)
            max_val = param_spec.get('max', 1.0)
            return [min_val, max_val, (min_val + max_val) / 2]
        elif param_type == 'categorical':
            return param_spec.get('values', [])
        elif param_type == 'bool':
            return [True, False]
        else:
            return []
    
    def extract_parameters_from_routes(self, extractor_code: str) -> Dict[str, Any]:
        """
        Extract parameters from all reaching route files using the provided extractor code.
        
        Args:
            extractor_code: Python code with extract_parameters(file_path) function
            
        Returns:
            Merged parameter space dictionary
        """
        try:
            # Load the extractor function
            extract_func = self._load_dynamic_extractor(extractor_code)
            
            # Get current possible routes
            possible_routes = self.get_possible_routes()
            
            if not possible_routes:
                self._log_error_to_file("No reaching routes available for parameter extraction", "parameter_extraction")
                return {}
            
            param_spaces = []
            successful_extractions = 0
            
            # Apply extractor to each reaching file
            for callstack, file_path in possible_routes.items():
                try:
                    if not os.path.exists(file_path):
                        self.logger.debug(f"Route file does not exist: {file_path}")
                        continue
                    
                    # Run extractor on this file
                    params = extract_func(file_path)
                    
                    if isinstance(params, dict):
                        param_spaces.append(params)
                        successful_extractions += 1
                        self.logger.debug(f"Successfully extracted parameters from {file_path}: {len(params)} parameters")
                    else:
                        self.logger.debug(f"Extractor returned non-dict for {file_path}: {type(params)}")
                
                except Exception as e:
                    self._log_error_to_file(f"Error extracting from {file_path}: {e}", "parameter_extraction")
                    continue
            
            if successful_extractions == 0:
                self._log_error_to_file("No successful parameter extractions from any route file", "parameter_extraction")
                return {}
            
            # Merge all parameter spaces
            merged_params = self._merge_parameter_spaces(param_spaces)
            
            self.logger.info(f"Successfully extracted and merged parameters from {successful_extractions} route files")
            self.logger.debug(f"Merged parameter space: {merged_params}")
            
            return merged_params
            
        except Exception as e:
            self._log_error_to_file(f"Failed to extract parameters: {e}", "parameter_extraction")
            return {}


class MCPCorpusServer:
    """MCP Server wrapper for Corpus functionality"""
    
    def __init__(self, output_dir: str, source_code_dir: Optional[str] = None):
        self.server = Server("corpus-server")
        self.corpus: Optional[Corpus] = None
        self.logger = logging.getLogger(__name__)
        self.error_log_file = Path(output_dir) / "corpus_errors.log"
        # Workflow state management for gatekeeper - fixed path in .cursor directory
        self.source_code_dir = Path(source_code_dir) if source_code_dir else Path.cwd()
        self.state_file_path = self.source_code_dir / ".cursor" / "workflow_state.md"
        
    def _check_workflow_gatekeeper(self, tool_name: str) -> Optional[str]:
        """Check workflow gatekeeper rules for tool access."""
        if not self.state_file_path or not self.state_file_path.exists():
            return f"🚫 **Workflow State Required**: No workflow state file found. Please ensure workflow_state.md exists at {self.state_file_path}"
        
        try:
            # Read current workflow state
            memory = read_workflow_state(self.state_file_path)
            current_phase = memory.state.phase
            
            # Check tool permission for PLAN phase tools
            if not check_tool_permission(current_phase, tool_name):
                return f"🚫 **Phase Gatekeeper**: Tool '{tool_name}' not allowed in {current_phase} phase. Must be in PLAN phase."
            
            return None  # Gatekeeper check passed
            
        except Exception as e:
            return f"🚫 **Workflow Error**: Failed to read workflow state: {e}"
    
    def _log_error_to_file(self, message: str, stage: str = "unknown") -> None:
        """Log error/warning messages to error.log file for later retrieval by agent."""
        utils.log_error_to_file(self.error_log_file, message, stage, "corpus_server", self.logger)
        
    def initialize_corpus(self, input_dir: str, output_dir: str, 
                         cmd_template: str, reached_pattern: str, static_result_folder: str) -> bool:
        """Initialize corpus with the provided configuration"""
        try:
            self.corpus = Corpus(input_dir, output_dir, cmd_template, reached_pattern, static_result_folder)
            self.corpus.start_processing()
            
            self.logger.info("Corpus initialized and processing started")
            self.logger.info(f"Input directory: {input_dir}")
            self.logger.info(f"Output directory: {output_dir}")
            self.logger.info(f"Command template: {cmd_template}")
            self.logger.info(f"Reached pattern: {reached_pattern}")
            self.logger.info(f"Static result folder: {static_result_folder}")
            
            return True
        except Exception as e:
            self.logger.error(f"Failed to initialize corpus: {str(e)}")
            return False
    
    def setup_handlers(self):
        """Setup MCP request handlers"""
        
        @self.server.list_tools()
        async def handle_list_tools() -> List[types.Tool]:
            """List available tools"""
            return [
                types.Tool(
                    name="get_reaching_routes",
                    description=(
                        "Get reaching routes with their associated testcases. "
                        "Returns callstack routes that successfully reach the target location, "
                        "along with the smallest testcase file for each route. "
                        "If no routes are available, falls back to basic reaching testcases."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False
                    }
                ),
                types.Tool(
                    name="get_corpus_status",
                    description=(
                        "Get the current status of corpus processing and route analysis. "
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {},
                        "additionalProperties": False
                    }
                ),
                types.Tool(
                    name="extract_parameters",
                    description=(
                        "Extract parameters from reaching route testcases using custom extractor code. "
                        "The extractor_code should contain an extract_parameters(file_path) function that "
                        "analyzes a testcase file and returns a parameter space dictionary. "
                        "This tool applies the extractor to all reaching route files and merges the results "
                        "into a unified parameter space suitable for property-based fuzzing."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "extractor_code": {
                                "type": "string",
                                "description": """Python code with an extract_parameters function for analyzing testcase files.

REQUIRED INTERFACE:
```python
def extract_parameters(file_path: str) -> Dict[str, Any]:
    import os  # All imports inside function
    
    # Analyze the file at file_path
    file_size = os.path.getsize(file_path)
    
    # Return parameter space dictionary
    return {
        "file_size": {
            "type": "int_range",
            "min": 0,
            "max": file_size * 2
        },
        "format_type": {
            "type": "categorical", 
            "values": ["xml", "json", "binary"]
        }
    }
```

## Key Rules
1. **Function signature**: Must have extract_parameters(file_path: str) -> Dict[str, Any]
2. **File analysis**: Use full abs file_path to read and analyze the testcase file
3. **Return format**: Return dictionary with parameter specifications
4. **Import inside function**: All imports must be inside extract_parameters()
5. **Parameter types**: Use standard types: int_range, float_range, categorical, bool, segments, base_seed

## Parameter Types
- **int_range**: `{"type": "int_range", "min": 0, "max": 100}`
- **float_range**: `{"type": "float_range", "min": 0.0, "max": 1.0}` 
- **categorical**: `{"type": "categorical", "values": ["xml", "json", "binary"]}`
- **bool**: `{"type": "bool"}`
- **segments**: `{"type": "segments", "count_range": {"min": 1, "max": 5}, "segment_params": {...}}`

The tool will merge parameter spaces from all reaching files into a unified space for fuzzing."""
                            }
                        },
                        "required": ["extractor_code"]
                    }
                )
            ]
        
        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> List[types.TextContent]:
            """Handle tool calls with gatekeeper enforcement"""
            
            # Gatekeeper check for all corpus tools (ANALYZE phase only)
            gatekeeper_error = self._check_workflow_gatekeeper(name)
            if gatekeeper_error:
                return [types.TextContent(
                    type="text",
                    text=gatekeeper_error + "\n\n**Required Actions:**\n"
                         "1. Read workflow_state.md to check current phase\n"
                         "2. Use transition_phase tool to transition to PLAN phase\n"
                         "3. Ensure all PLAN phase prerequisites are met\n"
                         "4. Then retry this tool"
                )]
            
            try:
                if name == "get_reaching_routes":
                    if not self.corpus:
                        return [types.TextContent(
                            type="text", 
                            text="Error: Corpus not initialized"
                        )]
                    
                    # Get possible routes data
                    possible_routes = self.corpus.get_possible_routes()
                    status = self.corpus.get_status()
                    
                    if possible_routes:
                        result_text = f"🛣️ **Reaching Routes Found**\n\n"
                        result_text += f"Found {len(possible_routes)} unique callstack routes to target location:\n\n"
                        
                        # Format routes in a readable way
                        for i, (callstack, testcase_path) in enumerate(possible_routes.items(), 1):
                            result_text += f"**Route {i}:**\n"
                            result_text += f"• **Testcase:** `{testcase_path}`\n"
                            result_text += f"• **Size:** {os.path.getsize(testcase_path)} bytes\n"
                            result_text += f"• **Callstack:**\n```\n{callstack}\n```\n\n"
                        
                        result_text += f"📊 **Analysis Stats:**\n"
                        result_text += f"• Routes analyzed: {status['routes_analyzed']}\n"
                        result_text += f"• Failed analyses: {status['failed_route_analysis']}\n"
                        
                        result_text += "These routes show different execution paths that successfully reach the target. "
                        result_text += "Analyze the callstacks to understand control flow patterns and the testcases to "
                        result_text += "extract input features that enable reaching the target."
                        
                        return [types.TextContent(type="text", text=result_text)]
                    else:
                        # Fallback to basic reaching testcase if no routes available yet
                        reaching_testcase = self.corpus.peek_reaching_testcase()
                        
                        if reaching_testcase:
                            result_text = f"⏳ **Route Analysis In Progress - Fallback Testcase**\n\n"
                            result_text += f"**File Path:** `{reaching_testcase}`\n\n"
                            result_text += "Route analysis is still processing. This testcase successfully reached the target location. "
                            result_text += f"Routes analyzed: {status['routes_analyzed']}\n\n"
                            result_text += "Try again later for detailed route information."
                            
                            return [types.TextContent(type="text", text=result_text)]
                        else:
                            if status["processing_complete"]:
                                result_text = "❌ **No Reaching Routes Available**\n\n"
                                result_text += f"Processing is complete. Processed {status['total_processed']} testcases "
                                result_text += f"but found no routes that reach the target.\n\n"
                                result_text += f"Analysis stats: {status['routes_analyzed']} analyzed, {status['failed_route_analysis']} failed\n\n"
                                result_text += "Please keep analyzing the codebase to figure out possible execution paths that reach the target."
                            else:
                                result_text = "⏳ **Processing In Progress**\n\n"
                                result_text += f"Still processing initial seed directory and analyzing routes. "
                                result_text += f"Processed: {status['total_processed']} testcases, "
                                result_text += f"Routes: {status['routes_analyzed']} analyzed, "
                                result_text += "Please try again later."
                            
                            return [types.TextContent(type="text", text=result_text)]
                
                elif name == "get_corpus_status":
                    if not self.corpus:
                        return [types.TextContent(
                            type="text", 
                            text="Error: Corpus not initialized"
                        )]
                    
                    status = self.corpus.get_status()
                    
                    result_text = "📊 **Corpus Status**\n\n"
                    result_text += f"**Processing Complete:** {'✅ Yes' if status['processing_complete'] else '⏳ No'}\n"
                    result_text += f"**Total Processed:** {status['total_processed']}\n"
                    result_text += f"**Reaching Testcases Found:** {status['reaching_found']}\n"
                    result_text += f"**Queue Size:** {status['queue_size']}\n\n"
                    
                    result_text += "🛣️ **Route Analysis:**\n"
                    result_text += f"**Routes Analyzed:** {status['routes_analyzed']}\n"
                    result_text += f"**Failed Analyses:** {status['failed_route_analysis']}\n"
                    result_text += f"**Possible Routes:** {status['possible_routes_count']}\n"
                    result_text += f"**Target Locations:** {status['target_locations_count']}\n\n"
                    
                    if status['processing_complete']:
                        if status['possible_routes_count'] > 0:
                            result_text += "🎯 Processing complete! Use `get_reaching_routes` to retrieve routes and testcases."
                        elif status['reaching_found'] > 0:
                            result_text += "⏳ Basic testcases found, route analysis may still be in progress."
                        else:
                            result_text += "❌ Processing complete but no reaching testcases found."
                    else:
                        result_text += "⏳ Still processing initial seed directory and analyzing routes..."
                    
                    return [types.TextContent(type="text", text=result_text)]
                
                elif name == "extract_parameters":
                    if not self.corpus:
                        return [types.TextContent(
                            type="text", 
                            text="Error: Corpus not initialized"
                        )]
                    
                    # Extract arguments
                    extractor_code = arguments.get("extractor_code", "")
                    
                    # Validate extractor code
                    if not extractor_code.strip():
                        return [types.TextContent(
                            type="text",
                            text="Error: extractor_code is required"
                        )]
                    
                    if "def extract_parameters(" not in extractor_code:
                        return [types.TextContent(
                            type="text",
                            text="Error: extractor_code must contain an 'extract_parameters' function definition"
                        )]
                    
                    try:
                        # Run parameter extraction
                        parameter_space = self.corpus.extract_parameters_from_routes(extractor_code)
                        
                        if not parameter_space:
                            result_text = "❌ **No Parameters Extracted**\n\n"
                            result_text += "No parameters could be extracted from reaching route files. This could be due to:\n"
                            result_text += "• No reaching routes available yet\n"
                            result_text += "• Extractor function errors\n"
                            result_text += "• Route files not accessible\n\n"
                            result_text += "Check corpus status and ensure reaching routes are available."
                            
                            return [types.TextContent(type="text", text=result_text)]
                        
                        # Format successful result
                        result_text = "🔍 **Parameter Extraction Complete**\n\n"
                        result_text += f"📊 **Extracted Parameters:** {len(parameter_space)} parameter(s)\n\n"
                        
                        result_text += "```json\n"
                        result_text += "{\n"
                        result_text += '  "parameter_space": {\n'
                        items = list(parameter_space.items())
                        for i, (param_name, param_spec) in enumerate(items):
                            # dump with indent then shift lines to desired offset
                            spec_json = json.dumps(param_spec, indent=4)
                            spec_json = "\n".join("    " + line for line in spec_json.splitlines())
                            result_text += f'    "{param_name}": {spec_json}'
                            if i < len(items) - 1:
                                result_text += ","
                            result_text += "\n"
                        result_text += "  }\n"
                        result_text += "}\n"
                        result_text += "```\n\n"
                        
                        return [types.TextContent(type="text", text=result_text)]
                    
                    except Exception as e:
                        self._log_error_to_file(f"Error in extract_parameters tool: {str(e)}", "tool_handling")
                        import traceback
                        error_details = traceback.format_exc()
                        
                        result_text = f"❌ **Parameter Extraction Failed**\n\n"
                        result_text += f"**Error:** {str(e)}\n\n"
                        result_text += "**Common Issues:**\n"
                        result_text += "• Syntax errors in extractor_code\n"
                        result_text += "• Missing imports in extract_parameters function\n"
                        result_text += "• File access errors\n"
                        result_text += "• Invalid return format from extract_parameters\n\n"
                        result_text += "**Debug Details:**\n"
                        result_text += f"```\n{error_details}\n```"
                        
                        return [types.TextContent(type="text", text=result_text)]
                
                else:
                    return [types.TextContent(
                        type="text",
                        text=f"Error: Unknown tool '{name}'"
                    )]
                    
            except Exception as e:
                self._log_error_to_file(f"Error handling tool '{name}': {str(e)}", "tool_handling")
                import traceback
                error_details = traceback.format_exc()
                return [types.TextContent(
                    type="text",
                    text=f"Error executing tool: {str(e)}\n\nDetails:\n{error_details}"
                )]

    async def run(self, input_dir: str, output_dir: str, cmd_template: str, reached_pattern: str, static_result_folder: str):
        """Run the MCP server"""
        # Initialize corpus
        if not self.initialize_corpus(input_dir, output_dir, cmd_template, reached_pattern, static_result_folder):
            return False
        
        # Setup handlers
        self.setup_handlers()
        
        # Run server
        async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
            self.logger.info("MCP Corpus Server started")
            await self.server.run(
                read_stream, 
                write_stream, 
                self.server.create_initialization_options()
            )

def setup_signal_handlers():
    """Setup signal handlers for immediate shutdown"""
    def signal_handler(signum, frame):
        print(f"\nReceived signal {signum}, shutting down immediately...")
        os._exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

def main():
    """Main entry point"""
    # Setup signal handlers early
    setup_signal_handlers()
    
    parser = argparse.ArgumentParser(
        description="MCP Server for Corpus Management",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Start corpus server with basic configuration
  # With AFL-style command template
  python mcp_corpus_server.py -i ./initial_seeds -o ./results -s ./static_results --reached-pattern "Target reached" -- ./target @@
        """
    )
    
    parser.add_argument(
        "-i", "--input-dir",
        required=True,
        help="Initial seed directory containing testcases to process"
    )
    parser.add_argument(
        "-o", "--output-dir",
        required=True,
        help="Output directory for processed testcases and queue"
    )
    parser.add_argument(
        "-s", "--static-result-folder",
        required=True,
        help="Path to static analysis results directory (containing BBtargets.txt)"
    )
    parser.add_argument(
        "--reached-pattern",
        default="REACHED",
        help="Regex pattern to detect when target location is reached (default: REACHED)"
    )
    parser.add_argument(
        "cmd",
        nargs="+",
        help="Command line for executing target program, use @@ to denote input file"
    )
    parser.add_argument(
        "--source-code-dir",
        required=False,
        help="Source code directory containing .cursor/workflow_state.md (default: current directory)"
    )
    
    args = parser.parse_args()
    
    # Set log level
    logging.basicConfig(
        level='ERROR',
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    # Validate paths
    if not os.path.exists(args.input_dir):
        print(f"Error: Input directory '{args.input_dir}' does not exist", file=sys.stderr)
        sys.exit(1)
    
    if not os.path.exists(args.static_result_folder):
        print(f"Error: Static result folder '{args.static_result_folder}' does not exist", file=sys.stderr)
        sys.exit(1)
    
    # Create output directory if it doesn't exist
    try:
        os.makedirs(args.output_dir, exist_ok=True)
    except Exception as e:
        print(f"Error creating output directory: {e}", file=sys.stderr)
        sys.exit(1)
    
    # Create and run server
    server = MCPCorpusServer(args.output_dir, source_code_dir=args.source_code_dir)
    
    try:
        asyncio.run(server.run(
            input_dir=args.input_dir,
            output_dir=args.output_dir,
            cmd_template=" ".join(args.cmd),
            reached_pattern=args.reached_pattern,
            static_result_folder=args.static_result_folder
        ))
    except KeyboardInterrupt:
        print("\nShutting down MCP Corpus Server...")
        os._exit(0)
    except Exception as e:
        print(f"Error running server: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
