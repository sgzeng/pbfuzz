import argparse
import json
import sys
import os
import logging
import subprocess
import shutil
from pathlib import Path

import utils
import config
from prompt import PromptBuilder

AT_FILE = "@@"


def _generate_fuzzer_config_block(config, fuzzer_config):
    """Build only the fuzzer config JSON block (source-code + target-location enrichment dropped)."""
    try:
        knowledge = utils.load_knowledge()
        prompt_engine = PromptBuilder(config, knowledge)
        return prompt_engine.build_fuzzer_config_block(fuzzer_config or {})
    except Exception as e:
        print(f"⚠️ Warning: Could not build fuzzer config block: {e}")
        return json.dumps(fuzzer_config or {}, indent=2)

def _build_tools_section(config):
    """Build dynamic tools section with availability notes"""
    tools_lines = [
        "## Available Tools\n",
        "**Fuzzing MCP Tools**\n",
        "- `get_generator_api_doc`: Generator API reference\n",
        "- `fuzz`: Execute fuzzing with plan and generator\n",
        "- `launch_interactive_gdb`: Launch interactive GDB session for advanced deviation analysis, root cause analysis, and TriggerPlan verification\n",
        "- `insert_oracle`: (build server) Insert printf-based reached/triggered oracle and upsert BBtargets.txt; PLAN phase only\n",
        "- `rebuild_project`: (build server) Run build_info.json build; EXECUTE phase only (initial build is done by the driver)\n\n",
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
        default=None,
        help="Output directory for results and logs (default: ./output without -config)",
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
        default=None,
        help="Maximum input generation iterations per fuzzing round (default: 1000 without -config)",
    )
    p.add_argument(
        "-reached-pattern",
        dest="reached_pattern",
        default=None,
        required=not has_config,
        help="Pattern to match for reached target (e.g: 'Bug .{0,19} reached')",
    )
    p.add_argument(
        "-triggered-pattern",
        dest="triggered_pattern",
        default=None,
        required=not has_config,
        help="Pattern to match for triggered bug (e.g: 'Bug .{0,19} triggered')",
    )
    p.add_argument(
        "-exec-timeout-sec",
        dest="exec_timeout_sec",
        type=int,
        default=None,
        help="Timeout in seconds for each execution (default: 1 without -config)",
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
        # Check API keys
        print("=== Environment Variables Check ===")
        api_keys = {
            "GEMINI_API_KEY": ["GOOGLE_API_KEY", "GOOGLE_GENERATIVEAI_API_KEY"],
            "OPENAI_API_KEY": [],
            "ANTHROPIC_API_KEY": []
        }
        
        for key, alternatives in api_keys.items():
            if os.getenv(key):
                print(f"✓ {key} is set")
            else:
                found_alternative = False
                for alt in alternatives:
                    if os.getenv(alt):
                        print(f"✓ {alt} is set (can be used for {key})")
                        found_alternative = True
                        break
                if not found_alternative:
                    print(f"✗ {key} not set")
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
    print("python launcher.py -config config.json")
    print()
    print("# Configuration file with overrides")
    print("python launcher.py -config my_experiment.json -debug -m gpt-4o")
    print()
    print("# Traditional command line approach (patterns required without -config)")
    print("python launcher.py -s ./static_results -m gemini-2.5-pro -c ./source \\")
    print("                   -reached-pattern 'T reached' -triggered-pattern 'T triggered' \\")
    print("                   ./target @@")
    print()
    print("# With debug")
    print("python launcher.py -s ./static_results -m gemini-2.5-pro -c ./source -debug \\")
    print("                   -reached-pattern 'T reached' -triggered-pattern 'T triggered' \\")
    print("                   ./target @@")
    print()
    print("# Without MCP servers (standalone mode)")
    print("python launcher.py -s ./static_results -m gpt-4o -c ./source -disable-mcp \\")
    print("                   -reached-pattern 'T reached' -triggered-pattern 'T triggered' \\")
    print("                   ./target @@")
    print()
    print("# Full parameter example")
    print("python launcher.py -s ./static_results -m gpt-4o -c ./source_code -o ./results \\")
    print("                   -debug -max-fuzz-gen 50 -exec-timeout-sec 5 \\")
    print("                   -reached-pattern 'TARGET_REACHED' -triggered-pattern 'BUG_TRIGGERED' \\")
    print("                   ./target @@")
    print()
    
    print("Command Line Parameters:")
    print("  -config PATH          Configuration file path (makes other required args optional)")
    print("  -s PATH               Static analysis results directory (required if no config)")
    print("  -m MODEL              LLM model name (e.g., sonnet-4, gpt-5, opus-4.1) (required if no config)")
    print("  -c PATH               Source code directory (required if no config)")
    print("  -i PATH               Initial corpus directory (optional)")
    print("  -o PATH               Output directory for results and logs, default ./output (optional)")
    print("  -debug                Enable debug mode (optional)")
    print("  -reached-pattern STR  Pattern for reached target (required if no -config)")
    print("  -triggered-pattern STR Pattern for triggered bug (required if no -config)")
    print("  -max-fuzz-gen N       Max iterations per round, default 1000 (optional)")
    print("  -exec-timeout-sec N   Timeout per execution in seconds, default 1 (optional)")
    print("  -disable-mcp          Disable MCP server integration (optional)")
    print()
    print("Configuration Priority (later overrides earlier):")
    print("  1. Default values from config.py")
    print("  2. Values from JSON configuration file (if -config provided)")
    print("  3. Command line arguments")
    print()


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
        fuzzer_config_json = _generate_fuzzer_config_block(config, fuzzer_config)
        dynamic_tools_block = _build_tools_section(config)
        template_content = _replace_tools_block(template_content, dynamic_tools_block)
        cve_id = getattr(config, "cve_id", "") or getattr(config, "task_id", "") or ""
        bcmd = getattr(config, "build_cmd", "") or ""
        bpath = getattr(config, "binary_path", "") or ""
        rcmd = getattr(config, "run_cmd_template", "") or (
            " ".join(config.cmd) if getattr(config, "cmd", None) else ""
        )
        build_obj = {
            "cve_id": cve_id,
            "build_cmd": bcmd,
            "binary_path": bpath,
            "cwd": getattr(config, "build_cwd", "") or getattr(config, "cybergym_cwd", "") or "",
            "run_cmd": list(config.cmd) if getattr(config, "cmd", None) else [],
        }
        build_info_json = json.dumps(build_obj, indent=2)
        bb_path = Path(config.static_result_folder) / "BBtargets.txt"
        formatted_content = template_content.format(
            llm_model=config.llm_model,
            task_id=cve_id or "(set during INIT)",
            cmd=" ".join(config.cmd) if getattr(config, "cmd", None) else "",
            source_code_folder=str(config.source_code_dir),
            output_dir=str(config.output_dir.absolute()),
            reached_pattern=config.reached_pattern,
            triggered_pattern=config.triggered_pattern,
            build_cmd=bcmd or "(set during INIT)",
            binary_path=bpath or "(set during INIT)",
            run_cmd_template=rcmd or "(set during INIT)",
            build_info_json=build_info_json,
            bbtargets_path=str(bb_path),
            fuzzer_config=fuzzer_config_json,
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

    # Mirror machine-readable build metadata for mcp_build_server / rebuild_project
    try:
        ws_root = Path(
            getattr(config, "workspace_root", None) or config.source_code_dir.parent
        )
        build_path = ws_root / "build_info.json"
        existing: dict = {}
        if build_path.is_file():
            try:
                existing = json.loads(build_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                existing = {}
        build_obj = {
            "cve_id": getattr(config, "cve_id", "") or getattr(config, "task_id", "") or existing.get("cve_id", ""),
            "build_cmd": getattr(config, "build_cmd", "") or existing.get("build_cmd", ""),
            "binary_path": getattr(config, "binary_path", "") or existing.get("binary_path", ""),
            "cwd": getattr(config, "build_cwd", "") or getattr(config, "cybergym_cwd", "") or existing.get("cwd", ""),
            "run_cmd": list(config.cmd) if getattr(config, "cmd", None) else existing.get("run_cmd", []),
            "bug_class": getattr(config, "bug_class", "") or existing.get("bug_class", ""),
            "sanitizer": getattr(config, "sanitizer", "") or existing.get("sanitizer", ""),
            "sanitizer_env": getattr(config, "sanitizer_env", None) or existing.get("sanitizer_env") or {},
        }
        build_path.write_text(json.dumps(build_obj, indent=2), encoding="utf-8")
        print(f"✓ Wrote {build_path}")
    except OSError as e:
        print(f"⚠️ Could not write build_info.json: {e}")
    
    return project_config_path, workflow_state_path


def generate_mcp_config(config, fuzzer_config=None):
    """Auto-generate .cursor/mcp.json with fuzzer/gdb/workflow/build servers."""
    script_dir = Path(__file__).parent.absolute()
    cursor_dir = config.source_code_dir / ".cursor"
    cursor_dir.mkdir(parents=True, exist_ok=True)
    mcp_config_path = cursor_dir / "mcp.json"

    abs_output_dir = Path(config.output_dir).absolute()
    abs_source_code_dir = Path(config.source_code_dir).absolute()
    abs_workspace_root = Path(
        getattr(config, "workspace_root", None) or abs_source_code_dir.parent
    ).absolute()

    servers = {
        "fuzzer": {
            "command": "python3",
            "args": [
                str(script_dir / "mcp_fuzzer_server.py"),
                "--output-dir", str(abs_output_dir),
                "--source-code-dir", str(abs_source_code_dir),
            ],
        },
        "gdb": {
            "command": "python3",
            "args": [
                str(script_dir / "mcp_gdb_server.py"),
                "--source-code-dir", str(abs_source_code_dir),
            ],
        },
        "workflow": {
            "command": "python3",
            "args": [
                str(script_dir / "mcp_workflow_server.py"),
                "--output-dir", str(abs_output_dir),
                "--source-code-dir", str(abs_source_code_dir),
            ],
        },
        "build": {
            "command": "python3",
            "args": [
                str(script_dir / "mcp_build_server.py"),
                "--source-code-dir", str(abs_source_code_dir),
                "--workspace-root", str(abs_workspace_root),
            ],
        },
    }

    mcp_config = {"mcpServers": servers}
    with open(mcp_config_path, "w") as f:
        json.dump(mcp_config, f, indent=2)

    print(f"✓ Generated MCP configuration: {mcp_config_path}")
    

def validate_args(args: argparse.Namespace) -> None:
    config_data: dict = {}
    if args.config_path:
        if not os.path.isfile(args.config_path):
            raise ValueError(f"Config file {args.config_path} does not exist")

        try:
            with open(args.config_path, 'r') as f:
                config_data = json.load(f)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON in config file {args.config_path}: {e}")

        if not args.static_result_folder and not config_data.get('static_result_folder'):
            raise ValueError("static_result_folder must be provided either via -s argument or in config file")
        if not args.llm_model and not config_data.get('llm_model'):
            raise ValueError("llm_model must be provided either via -m argument or in config file")
        if not args.source_code_folder and not config_data.get('source_code_folder'):
            raise ValueError("source_code_folder must be provided either via -c argument or in config file")
        if not args.cmd and not config_data.get('cmd'):
            raise ValueError("cmd must be provided either as positional argument or in config file")
        if not args.reached_pattern and not config_data.get("reached_pattern"):
            raise ValueError(
                "reached_pattern must be provided via -reached-pattern or in the config file"
            )
        if not args.triggered_pattern and not config_data.get("triggered_pattern"):
            raise ValueError(
                "triggered_pattern must be provided via -triggered-pattern or in the config file"
            )
    else:
        if not args.static_result_folder:
            raise ValueError("static_result_folder (-s) is required when no config file is provided")
        if not args.source_code_folder:
            raise ValueError("source_code_folder (-c) is required when no config file is provided")
        if not args.cmd:
            raise ValueError("cmd is required when no config file is provided")
        if not args.reached_pattern:
            raise ValueError("reached_pattern (-reached-pattern) is required when no config file is provided")
        if not args.triggered_pattern:
            raise ValueError("triggered_pattern (-triggered-pattern) is required when no config file is provided")

    static_folder = args.static_result_folder or config_data.get("static_result_folder")
    source_folder = args.source_code_folder or config_data.get("source_code_folder")

    if source_folder and not os.path.isdir(source_folder):
        raise ValueError(f"{source_folder} no such directory")

    # Only BBtargets.txt is required (it drives insert_oracle / fuzz target locations).
    # function_info.txt / bid_loc_mapping.txt are optional static-analysis enrichment.
    if static_folder:
        Path(static_folder).mkdir(parents=True, exist_ok=True)
        bb = Path(static_folder) / "BBtargets.txt"
        if not bb.is_file() or bb.stat().st_size == 0:
            raise ValueError(f"{bb} missing or empty (INIT must populate it from patch.diff)")


def main():
    # Check for help-usage before parsing all args to avoid required arg errors
    if '-help' in sys.argv:
        show_system_status()
        show_usage_examples()
        return
    
    args = parse_args()

    # Without -config, apply CLI defaults here so JSON-loaded values are not overwritten by argparse defaults.
    if not args.config_path:
        if args.output_dir is None:
            args.output_dir = "./output"
        if args.max_iters is None:
            args.max_iters = 1000
        if args.exec_timeout_sec is None:
            args.exec_timeout_sec = 1

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

    print("✓ Generated prompt.txt, workflow files, and MCP config (if enabled).")

if __name__ == "__main__":
    main()
