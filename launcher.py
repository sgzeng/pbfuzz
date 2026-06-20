import argparse
import json
import sys
import os
import logging
import subprocess
import shutil
from pathlib import Path
import base64

def install_cursor_auth(raw_b64: str | None) -> None:
    """Decode base64 cursor auth JSON into ~/.config/cursor/auth.json.

    This is only needed for CI/container environments where cursor-agent has
    no existing session.  In local dev, cursor-agent manages its own auth via
    `cursor-agent login` and this function is a no-op.
    """
    raw = raw_b64 or os.environ.get("CURSOR_AUTH", "")
    if not str(raw).strip():
        # No explicit auth provided — cursor-agent will use its own session.
        home = Path(os.environ.get("HOME", str(Path.home())))
        if (home / ".config" / "cursor" / "auth.json").is_file():
            return
        # Not a hard error: cursor-agent may be authenticated via `cursor-agent login`.
        return
    home = Path(os.environ.get("HOME", str(Path.home())))
    path = home / ".config" / "cursor" / "auth.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    cleaned = "".join(str(raw).split())
    try:
        decoded = base64.standard_b64decode(cleaned)
    except Exception as e:
        print(f"CURSOR_AUTH / --cursor-auth-b64 is not valid base64: {e}", file=sys.stderr)
        sys.exit(1)
    path.write_bytes(decoded)

import utils
import config
from prompt import PromptBuilder

AT_FILE = "@@"

def _generate_dynamic_content(config, fuzzer_config):
    """Generate dynamic content using PromptBuilder"""
    try:
        knowledge = utils.load_knowledge()
        prompt_engine = PromptBuilder(config, knowledge)
        source_code_blocks = prompt_engine.build_source_code_blocks()
        target_locations = prompt_engine.build_target_locations_block()
        fuzzer_config_json = prompt_engine.build_fuzzer_config_block(fuzzer_config or {})
        return source_code_blocks, target_locations, fuzzer_config_json
    except Exception as e:
        print(f"⚠️ Warning: Could not generate dynamic content: {e}")
        return (
            "<!-- Source code blocks will be generated when available -->",
            "<!-- Target locations will be generated when available -->",
            "{}"
        )

def _check_file_exists(static_dir, filename):
    """Check if a file exists and is not empty"""
    fp = static_dir / filename
    return fp.exists() and fp.is_file() and fp.stat().st_size > 0

def _get_missing_files_note(missing_list):
    """Generate availability note for missing files"""
    if not missing_list:
        return ""
    if len(missing_list) == 1:
        return f" (not available for this bug because static analysis result '{missing_list[0]}' is missing)"
    return " (not available for this bug because static analysis results " + ", ".join(f"'{m}'" for m in missing_list) + " are missing)"

def _build_tools_section(config):
    """Build dynamic tools section with availability notes"""
    static_dir = Path(config.static_result_folder)
    
    # Check for missing files
    callgraph_missing = [fname for fname in ["caller-callee.txt", "callee-caller.txt"] 
                        if not _check_file_exists(static_dir, fname)]
    corpus_missing = [fname for fname in ["BBtargets.txt", "function_info.txt", "bid_loc_mapping.txt"]
                      if not _check_file_exists(static_dir, fname)]
    deviation_missing = [fname for fname in ["critical_BBs.txt"]
                         if not _check_file_exists(static_dir, fname)]
    
    # Build tools lines
    tools_lines = [
        "## Available Tools\n",
        "**Analysis MCP Tools**\n",
        f"- `get_callers`, `get_callees`: Call graph analysis{_get_missing_files_note(callgraph_missing)}\n",
        f"- `get_reaching_routes`: Routes and input files that reach targets{_get_missing_files_note(corpus_missing)}\n",
        f"- `get_corpus_status`: Corpus analysis progress{_get_missing_files_note(corpus_missing)}\n",
        f"- `extract_parameters`: Parameter space from reaching testcases{_get_missing_files_note(corpus_missing)}\n",
        f"- `detect_deviation`: Find execution deviations from expected paths{_get_missing_files_note(deviation_missing)}\n",
        "- `get_generator_api_doc`: Generator API reference\n",
        "- `fuzz`: Execute fuzzing with plan and generator\n",
        "- `launch_interactive_gdb`: Launch interactive GDB session for advanced deviation analysis, root cause analysis, and TriggerPlan verification\n\n",
        "**Workflow MCP Tools**\n",
        "- `write_workflow_block(target_block, content_json)`: Write JSON to specific workflow blocks\n",
        "- `transition_phase(next_phase)`: Transition to next phase with gatekeeper validation\n",
        "- `check_phase_completion()`: Check if current phase tasks are completed\n",
        "- `get_current_phase()`: Get current phase information\n"
    ]
    
    return "<!-- STATIC:TOOLS_AND_REQUIREMENTS:START -->\n" + "".join(tools_lines) + "<!-- STATIC:TOOLS_AND_REQUIREMENTS:END -->"

def _replace_tools_block(template_content, dynamic_tools_block):
    """Replace the static tools block with dynamic one"""
    start_tag = "<!-- STATIC:TOOLS_AND_REQUIREMENTS:START -->"
    end_tag = "<!-- STATIC:TOOLS_AND_REQUIREMENTS:END -->"
    
    if start_tag in template_content and end_tag in template_content:
        start_idx = template_content.find(start_tag)
        end_idx = template_content.find(end_tag) + len(end_tag)
        return template_content[:start_idx] + dynamic_tools_block + template_content[end_idx:]
    return template_content


def parse_args() -> argparse.Namespace:
    # First, do a preliminary parse to check for config file
    has_config = '-config' in sys.argv
    
    p = argparse.ArgumentParser(description="LLM-assisted Property-based Directed Fuzzer")
    p.add_argument(
        "-help", 
        action="store_true",
        help="Show detailed usage examples and system information"
    )
    p.add_argument(
        "-config",
        dest="config_path",
        default=None,
        help="path of configuration file (if provided, other required arguments become optional)",
    )
    p.add_argument(
        "--cursor-auth-b64",
        dest="cursor_auth_b64",
        default=None,
        help="Base64-encoded ~/.config/cursor/auth.json (else env CURSOR_AUTH)",
    )
    p.add_argument(
        "-s",
        dest="static_result_folder",
        required=not has_config,  # Only required if no config file
        help="static analysis results folder that saves the distance information and initial policy",
    )
    p.add_argument(
        "-m",
        dest="llm_model", # sonnet-4.5, gpt-5, opus-4.1
        required=not has_config,  # Only required if no config file
        help="LLM model name",
    )
    p.add_argument(
        "-c",
        dest="source_code_folder",
        required=not has_config,  # Only required if no config file
        help="source code folder of the program under test",
    )
    p.add_argument(
        "-i",
        dest="initial_corpus_dir",
        required=False,
        help="initial corpus directory",
    )
    p.add_argument(
        "-o",
        dest="output_dir",
        default="./output",
        help="Output directory for results and logs (default: ./output)",
    )
    p.add_argument(
        "-debug",
        dest="debug_enabled",
        action="store_true",
        help="Enable debug mode",
    )
    p.add_argument(
        "-max-fuzz-gen",
        dest="max_iters",
        type=int,
        default=1000,
        help="Maximum input generation iterations per fuzzing round (default: 100)",
    )
    p.add_argument(
        "-reached-pattern",
        dest="reached_pattern",
        required=not has_config,  # Only required if no config file
        default=None,
        help="Pattern to match for reached target (e.g: 'Bug .{0,19} reached')",
    )
    p.add_argument(
        "-triggered-pattern",
        dest="triggered_pattern",
        required=not has_config,  # Only required if no config file
        default=None,
        help="Pattern to match for triggered bug (e.g: 'Bug .{0,19} triggered')",
    )
    p.add_argument(
        "-exec-timeout-sec",
        dest="exec_timeout_sec",
        type=int,
        default=None,
        help="Timeout in seconds for each execution (default: 3)",
    )
    p.add_argument(
        "-agent-timeout-sec",
        dest="agent_timeout_sec",
        type=int,
        default=None,
        help="Timeout in seconds for the cursor-agent session (default: 3600)",
    )
    p.add_argument(
        "-disable-mcp",
        dest="disable_mcp",
        action="store_true",
        help="Disable MCP server",
    )
    p.add_argument(
        "cmd",
        nargs="*",
        help=f"cmdline, use {AT_FILE} to denote an input file",
    )
    
    # Manually handle separator because we are using '*' instead of '+'
    args = sys.argv[1:]
    
    # Find the -- separator
    if '--' in args:
        separator_index = args.index('--')
        # Split arguments at the -- separator
        option_args = args[:separator_index]
        cmd_args = args[separator_index + 1:]  # Skip the -- itself
        # Parse the options first
        parsed_args = p.parse_args(option_args)
        # Add the command arguments
        parsed_args.cmd = cmd_args
        return parsed_args
    else:
        return p.parse_args()

def show_system_status():
    """Display system status information"""
    try:
        print("=== Environment Variables Check ===")
        cursor_auth = os.getenv("CURSOR_AUTH", "")
        if cursor_auth.strip():
            print("✓ CURSOR_AUTH is set")
        else:
            print("✗ CURSOR_AUTH not set (cursor-agent will use local session if available)")
    except Exception as e:
        print(f"Error checking system status: {e}")

def show_usage_examples():
    """Show usage examples"""
    print("=== Fuzzing Loop System Usage Guide ===\n")
    
    print("System Architecture:")
    print("1. LLMAgent: Core agent, maintains chat history and state")
    print("2. PromptBuilder: Build protocol-compliant prompts")
    print("3. RequestHandler: Handle agent requests and execute tests")
    print("4. Loop process: init → prompt → LLM → process → iterate")
    print()
    
    print("Key Features:")
    print("✓ State management: maintain multi-round chat history")
    print("✓ Response parsing: auto parse Block A(JSON) and Block B(Python)")
    print("✓ Request handling: integrated RequestHandler for various requests")
    print("✓ Loop execution: automatic iteration to optimize test generation")
    print()
    
    print("Usage Examples:")
    print("# Configuration file approach (recommended)")
    print("python3 launcher.py -config config.json")
    print()
    print("# Configuration file with overrides")
    print("python3 launcher.py -config my_experiment.json -debug -m gpt-4o")
    print()
    print("# Traditional command line approach")
    print("python3 launcher.py -s ./static_results -m gemini-2.5-pro -c ./source \\")
    print("                    -reached-pattern 'TARGET_REACHED' -triggered-pattern 'BUG_TRIGGERED' \\")
    print("                    ./target @@")
    print()
    print("# Without MCP servers (standalone mode)")
    print("python3 launcher.py -s ./static_results -m gpt-4o -c ./source -disable-mcp \\")
    print("                    -reached-pattern 'REACHED' -triggered-pattern 'TRIGGERED' ./target @@")
    print()
    print("# Full parameter example")
    print("python3 launcher.py -s ./static_results -m gpt-4o -c ./source_code -o ./results \\")
    print("                    -debug -max-fuzz-gen 50 -exec-timeout-sec 5 -agent-timeout-sec 1200 \\")
    print("                    -reached-pattern 'TARGET_REACHED' -triggered-pattern 'BUG_TRIGGERED' \\")
    print("                    ./target @@")
    print()

    print("Command Line Parameters:")
    print("  -config PATH           Configuration file path (makes other required args optional)")
    print("  -s PATH                Static analysis results directory (required if no config)")
    print("  -m MODEL               LLM model name (e.g., gemini-2.5-pro, claude-sonnet-4-6, gpt-4o)")
    print("  -c PATH                Source code directory (required if no config)")
    print("  -reached-pattern STR   Pattern for reached target (required if not in config)")
    print("  -triggered-pattern STR Pattern for triggered bug (required if not in config)")
    print("  -i PATH                Initial corpus directory (optional)")
    print("  -o PATH                Output directory, default ./output (optional)")
    print("  -debug                 Enable debug mode (optional)")
    print("  -max-fuzz-gen N        Max input generation iterations per round, default 1000 (optional)")
    print("  -exec-timeout-sec N    Timeout per execution in seconds, default 3 (optional)")
    print("  -agent-timeout-sec N   Timeout for the cursor-agent session in seconds, default 3600 (optional)")
    print("  -disable-mcp           Disable MCP server integration (optional)")
    print()
    print("Configuration Priority (later overrides earlier):")
    print("  1. Default values from config.py")
    print("  2. Values from JSON configuration file (if -config provided)")
    print("  3. Command line arguments")
    print()
    

def execute_cursor_agent(config):
    """Execute cursor-agent with real-time log streaming"""
    prompt_file = config.output_dir / "prompt.txt"
    log_file = config.output_dir / "agent.log"

    if not config.source_code_dir.exists():
        raise ValueError(f"Source code directory does not exist: {config.source_code_dir}")

    abs_prompt_file = prompt_file.absolute()
    # --approve-mcps: auto-approve MCP server startup in headless -p mode
    #   (without this flag cursor-agent silently skips all MCP servers because
    #    it cannot prompt for approval interactively)
    # --trust: trust the workspace without prompting (headless-only)
    cmd_str = (
        f'cursor-agent --force --approve-mcps --trust'
        f' --output-format stream-json -p "$(cat {abs_prompt_file})"'
    )
    if config.llm_model:
        cmd_str = f'{cmd_str} --model "{config.llm_model}"'

    # Pre-flight: verify cursor-agent is authenticated before launching
    auth_check = subprocess.run(
        ["cursor-agent", "status"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    auth_output = (auth_check.stdout + auth_check.stderr).lower()
    if auth_check.returncode != 0 or "not logged" in auth_output or "sign in" in auth_output:
        print("cursor-agent is not authenticated. Run: cursor-agent login", file=sys.stderr)
        sys.exit(1)

    mcp_config_file = config.source_code_dir / ".cursor" / "mcp.json"
    print(f"Working directory: {config.source_code_dir}")
    print(f"Log file: {log_file}")
    if not config.disable_mcp and mcp_config_file.exists():
        print(f"MCP config: {mcp_config_file}")
    else:
        print("MCP servers: Disabled")
    print(f"Running: {cmd_str}")

    with open(log_file, "w") as log_f:
        process = subprocess.Popen(
            cmd_str,
            shell=True,
            cwd=str(config.source_code_dir.absolute()),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        for line in process.stdout:
            print(line, end="", flush=True)
            log_f.write(line)
            log_f.flush()
        try:
            timeout = getattr(config, 'agent_timeout_sec', None)
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise RuntimeError(f"cursor-agent timed out after {timeout}s")

    if process.returncode != 0:
        raise RuntimeError(f"cursor-agent exited with code {process.returncode}")

    print(f"\n✓ cursor-agent completed. Log: {log_file}")

def create_workflow_files(config, fuzzer_config=None):
    """Auto-create workflow memory files in source code directory"""
    # Create .cursor directory in source code directory
    workflow_dir = config.source_code_dir / ".cursor"
    workflow_dir.mkdir(parents=True, exist_ok=True)
    
    project_config_path = workflow_dir / "project_config.md"
    workflow_state_path = workflow_dir / "workflow_state.md"
    schemas_path = config.source_code_dir / "schemas.py"
    
    # Get template directory
    script_dir = Path(__file__).parent.absolute()
    template_dir = script_dir / "templates"
    # Copy schemas.py for Pydantic model definitions
    shutil.copy2(script_dir / "schemas.py", schemas_path)
    
    # Create project_config.md from template
    template_path = template_dir / "project_config.md"
    if template_path.exists():
        template_content = template_path.read_text()
        # Generate dynamic content
        source_code_blocks, target_locations, fuzzer_config_json = _generate_dynamic_content(config, fuzzer_config)
        # Build tools section with availability notes
        dynamic_tools_block = _build_tools_section(config)
        # Replace tools block in template
        template_content = _replace_tools_block(template_content, dynamic_tools_block)
        # Format template with config values
        formatted_content = template_content.format(
            llm_model=config.llm_model,
            cmd=" ".join(config.cmd),
            source_code_folder=str(config.source_code_dir),
            output_dir=str(config.output_dir.absolute()),
            reached_pattern=config.reached_pattern,
            triggered_pattern=config.triggered_pattern,
            source_code_blocks=source_code_blocks,
            target_locations=target_locations,
            fuzzer_config=fuzzer_config_json
        )
        project_config_path.write_text(formatted_content)
        print(f"✓ Created project config: {project_config_path}")
    else:
        print(f"⚠️ Template not found: {template_path}")

    # Create workflow_state.md from template
    template_path = template_dir / "workflow_state.md"
    if template_path.exists():
        shutil.copy2(template_path, workflow_state_path)
        print(f"✓ Created workflow state: {workflow_state_path}")
    else:
        print(f"⚠️ Template not found: {template_path}")
    
    return project_config_path, workflow_state_path


def generate_mcp_config(config, fuzzer_config=None):
    """Auto-generate .cursor/mcp.json based on config"""
    # Get the absolute path to the MCP servers
    script_dir = Path(__file__).parent.absolute()
    
    # Create .cursor directory in source code directory
    cursor_dir = config.source_code_dir / ".cursor"
    cursor_dir.mkdir(parents=True, exist_ok=True)
    mcp_config_path = cursor_dir / "mcp.json"
    
    corpus_dir = config.initial_corpus_dir
    if not corpus_dir.exists():
        corpus_dir.mkdir(exist_ok=True)
    if len(list(corpus_dir.iterdir())) == 0:
        (corpus_dir / "empty.txt").write_text("")
    
    # Convert all paths to absolute paths
    abs_static_folder = Path(config.static_result_folder).absolute()
    abs_corpus_dir = Path(corpus_dir).absolute()
    abs_output_dir = Path(config.output_dir).absolute()
    
    # Build MCP server configurations with absolute paths
    abs_source_code_dir = Path(config.source_code_dir).absolute()
    
    # Build servers conditionally based on static analysis files availability
    def has_file(name: str) -> bool:
        fp = abs_static_folder / name
        return fp.exists() and fp.is_file() and fp.stat().st_size > 0

    servers = {}

    # Essential files (function_info.txt, bid_loc_mapping.txt, BBtargets.txt) are already validated in validate_args
    # Callgraph server (requires additional files beyond essentials)
    callgraph_requirements = ["caller-callee.txt", "callee-caller.txt"]
    if all(has_file(n) for n in callgraph_requirements):
        servers["callgraph"] = {
            "command": "python3",
            "args": [
                str(script_dir / "mcp_call_graph_server.py"),
                "--static-folder",
                str(abs_static_folder),
                "--source-code-dir",
                str(abs_source_code_dir)
            ]
        }

    # Corpus server (requires BBtargets.txt, function_info.txt, bid_loc_mapping.txt)
    corpus_requirements = ["BBtargets.txt", "function_info.txt", "bid_loc_mapping.txt"]
    if all(has_file(n) for n in corpus_requirements):
        servers["corpus"] = {
            "command": "python3",
            "args": [
                str(script_dir / "mcp_corpus_server.py"),
                "-i", str(abs_corpus_dir),
                "-o", str(abs_output_dir),
                "-s", str(abs_static_folder),
                "--reached-pattern", config.reached_pattern,
                "--source-code-dir", str(abs_source_code_dir),
                "--"
            ] + config.cmd
        }

    # Fuzzer server (no static deps)
    servers["fuzzer"] = {
        "command": "python3",
        "args": [
            str(script_dir / "mcp_fuzzer_server.py"),
            "--output-dir", str(abs_output_dir),
            "--source-code-dir", str(abs_source_code_dir)
        ]
    }

    # Deviation detector (requires critical_BBs.txt)
    deviation_requirements = ["critical_BBs.txt"]
    if all(has_file(n) for n in deviation_requirements):
        servers["deviation_detector"] = {
            "command": "python3",
            "args": [
                str(script_dir / "mcp_deviation_detector_server.py"),
                "--static-folder", str(abs_static_folder),
                "--reached-pattern", config.reached_pattern,
                "--exec-timeout-sec", str(config.exec_timeout_sec),
                "--source-code-dir", str(abs_source_code_dir),
                "--"
            ] + config.cmd
        }

    # GDB server (no static deps)
    servers["gdb"] = {
        "command": "python3",
        "args": [
            str(script_dir / "mcp_gdb_server.py"),
            "--source-code-dir", str(abs_source_code_dir)
        ]
    }

    # Workflow server (no static deps)
    servers["workflow"] = {
        "command": "python3",
        "args": [
            str(script_dir / "mcp_workflow_server.py"),
            "--output-dir", str(abs_output_dir),
            "--source-code-dir", str(abs_source_code_dir)
        ]
    }

    mcp_config = {"mcpServers": servers}

    # Write project-level MCP configuration
    with open(mcp_config_path, 'w') as f:
        json.dump(mcp_config, f, indent=2)
    print(f"✓ Generated MCP configuration: {mcp_config_path}")

    # cursor-agent in headless -p mode ignores the project-level .cursor/mcp.json;
    # it only loads MCP servers from the global ~/.cursor/mcp.json.  Write there too.
    home = Path(os.environ.get("HOME", str(Path.home())))
    global_mcp_path = home / ".cursor" / "mcp.json"
    global_mcp_path.parent.mkdir(parents=True, exist_ok=True)
    with open(global_mcp_path, 'w') as f:
        json.dump(mcp_config, f, indent=2)
    print(f"✓ Also wrote global MCP configuration: {global_mcp_path}")
    

def validate_args(args: argparse.Namespace) -> None:
    # If config file is provided, load it first to get default values
    if args.config_path:
        if not os.path.isfile(args.config_path):
            raise ValueError(f"Config file {args.config_path} does not exist")
        
        # Load config to check if required fields are present
        try:
            with open(args.config_path, 'r') as f:
                config_data = json.load(f)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON in config file {args.config_path}: {e}")
        
        # Check that either command line args or config file provides required values
        if not args.static_result_folder and not config_data.get('static_result_folder'):
            raise ValueError("static_result_folder must be provided either via -s argument or in config file")
        if not args.llm_model and not config_data.get('llm_model'):
            raise ValueError("llm_model must be provided either via -m argument or in config file")
        if not args.source_code_folder and not config_data.get('source_code_folder'):
            raise ValueError("source_code_folder must be provided either via -c argument or in config file")
        if not args.cmd and not config_data.get('cmd'):
            raise ValueError("cmd must be provided either as positional argument or in config file")
        if not args.reached_pattern and not config_data.get('reached_pattern'):
            raise ValueError("reached_pattern must be provided either via -reached-pattern argument or in config file")
        if not args.triggered_pattern and not config_data.get('triggered_pattern'):
            raise ValueError("triggered_pattern must be provided either via -triggered-pattern argument or in config file")
    else:
        # No config file, so command line args are required
        if not args.static_result_folder:
            raise ValueError("static_result_folder (-s) is required when no config file is provided")
        if not args.source_code_folder:
            raise ValueError("source_code_folder (-c) is required when no config file is provided")
        if not args.cmd:
            raise ValueError("cmd is required when no config file is provided")

    # Validate directories if they are provided
    folders_to_check = []
    if args.static_result_folder:
        folders_to_check.append(args.static_result_folder)
    if args.source_code_folder:
        folders_to_check.append(args.source_code_folder)
    
    for folder in folders_to_check:
        if not os.path.isdir(folder):
            raise ValueError(f"{folder} no such directory")

    # Only BBtargets.txt is required; function_info.txt / bid_loc_mapping.txt are
    # optional static-analysis enrichment — their absence degrades gracefully.
    if args.static_result_folder:
        fp = Path(args.static_result_folder) / "BBtargets.txt"
        if not fp.is_file():
            raise ValueError(f"{fp} does not exist.")
        if fp.stat().st_size == 0:
            raise ValueError(f"{fp} is empty.")
   
def main():
    # Check for help-usage before parsing all args to avoid required arg errors
    if '-help' in sys.argv:
        show_system_status()
        show_usage_examples()
        return
    
    args = parse_args()
    
    # Decode base64 cursor auth JSON if provided or available in env
    install_cursor_auth(getattr(args, 'cursor_auth_b64', None))
    
    validate_args(args)

    myconfig = config.Config()
    myconfig.load(args.config_path)
    myconfig.load_put_args(args)
    
    logging.basicConfig(level=myconfig.logging_level)
    # Ensure output directory exists
    myconfig.output_dir.mkdir(parents=True, exist_ok=True)
    
    fuzzer_config = {
        "cmd": " ".join(myconfig.cmd),
        "reached_pattern": myconfig.reached_pattern,
        "triggered_pattern": myconfig.triggered_pattern,
        "max_iters": myconfig.max_iters,
        "exec_timeout_sec": myconfig.exec_timeout_sec
    }
    knowledge = utils.load_knowledge()
    prompt_engine = PromptBuilder(myconfig, knowledge)
    prompt_str = prompt_engine.build_prompt(fuzzer_config)
    create_workflow_files(myconfig, fuzzer_config)
    with open(myconfig.output_dir / "prompt.txt", "w") as f:
        f.write(prompt_str)
    
    # Generate MCP config only if MCP is enabled
    if not myconfig.disable_mcp:
        generate_mcp_config(myconfig, fuzzer_config)
    else:
        print("✓ MCP servers disabled, skipping MCP configuration generation")
    
    # Execute cursor-agent with timeout and logging
    execute_cursor_agent(myconfig)

if __name__ == "__main__":
    main()
