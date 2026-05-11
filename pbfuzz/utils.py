import collections
import datetime
import json
import os
import resource
import shlex
from pathlib import Path

AT_FILE = "@@"
MILLI_SECONDS_SCALE = 1000

def get_project_root():
    return Path(__file__).parent.absolute()

def mkdir(dirp):
    if not os.path.exists(dirp):
        os.makedirs(dirp)

def get_folder_size(dir_path):
    total_size = 0
    seen_inodes = set()
    for dirpath, dirnames, filenames in os.walk(dir_path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            try:
                stat = os.stat(fp)
                if stat.st_ino not in seen_inodes:
                    seen_inodes.add(stat.st_ino)
                    total_size += stat.st_size
            except:
                continue
    return total_size

def disable_core_dump():
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except ValueError:
        print(f"Failed to disable core dump. \n"
                    f"Please try to set it manually by running: "
                    f"'ulimit -c 0'")

def hexdump(file_content, width=16):
    """
    Mimics the behavior of `xxd` and generates a hexadecimal dump of the given binary content.
    
    :param file_content: Binary content to be dumped.
    :param width: Number of bytes per line (default: 16).
    :return: A formatted hexdump string.
    """
    hex_lines = []
    for offset in range(0, len(file_content), width):
        chunk = file_content[offset : offset + width] 
        # Convert to hex
        hex_part = " ".join(f"{b:02x}" for b in chunk)
        # Convert to ASCII representation (printable characters or '.')
        ascii_part = "".join(chr(b) if 32 <= b < 127 else '.' for b in chunk)
        # Format the line similar to xxd output
        hex_lines.append(f"{offset:08x}: {hex_part.ljust(width * 3)} {ascii_part}")
    return "\n".join(hex_lines)

def load_knowledge():
    knowledge = {}
    cur_dir = os.path.dirname(os.path.abspath(__file__))
    json_file_path = os.path.join(cur_dir, "knowledge.json")
    try:
        with open(json_file_path, "r") as file:
            data = json.load(file)
    except:
        print(f"Failed to load prior knowledge from {json_file_path}")
        return knowledge
    if not isinstance(data, dict):
        print(f"Invalid prior knowledge format in {json_file_path}")
        return knowledge
    for key, value in data.items():
        knowledge[key] = value
    if not "projects" in knowledge:
        print(f"LLM assistant requires prior knowledge of projects")
        return knowledge
    knowledge["bin_to_project"] = collections.defaultdict(str)
    for project, bin_list in knowledge["projects"].items():
        for bin in bin_list:
            knowledge["bin_to_project"][bin] = project
    return knowledge

def prepare_cmd_and_stdin(cmd_template: str, testcase_path_for_cmd: str, file_content: bytes):
    """Fixed version that separates command path from file reading path.
    
    Args:
        cmd_template: Command template string
        testcase_path_for_cmd: Path to use in command arguments
        file_content: Pre-read file content
        
    Returns:
        tuple: (cmd_args, stdin_data)
    """
    # Handle AFL-style @@ placeholder or stdin input
    cmd_args = shlex.split(cmd_template)
    # Use our own fixed version of fix_at_file that doesn't read the file again
    cmd_args = cmd_args[:]  # Make a copy
    if AT_FILE in cmd_args:
        idx = cmd_args.index(AT_FILE)
        cmd_args[idx] = testcase_path_for_cmd
        stdin_data = None
    else:
        stdin_data = file_content
    return cmd_args, stdin_data

def log_error_to_file(error_log_file, message: str, stage: str = "unknown", 
                      service_name: str = "service", logger=None) -> None:
    """
    Log error/warning messages to error.log file for later retrieval by agent.
    
    Args:
        error_log_file: Path to the error log file (str or Path object)
        message: Error message to log
        stage: Stage where error occurred (e.g., 'initialization', 'execution', etc.)
        service_name: Name of the service logging the error (e.g., 'corpus_server', 'deviation_detector')
        logger: Optional logger instance for fallback logging
    """
    try:
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_entry = f"[{timestamp}] [{service_name}] [{stage}] {message}\n"
        
        # Append to error log file
        with open(error_log_file, "a", encoding="utf-8") as f:
            f.write(log_entry)
        
        # Also log to regular logger for debugging if provided
        if logger:
            logger.warning(f"[{stage}] {message}")
        
    except Exception as e:
        # Fallback to regular logger if file writing fails
        if logger:
            logger.warning(f"Failed to write to error log: {e}")
            logger.warning(f"[{stage}] {message}")

def get_line_with_content(file_path, content, start_after=0):
    """
    Find the line number in a file that contains the given content.

    Args:
        file_path (str): The path to the file.
        content (str): The unique content to search for in the file.
        start_after (int): The line number to start searching from (exclusive).

    Returns:
        int: The 1-based line number containing the content.

    Raises:
        AssertionError: If the content is not found in the file.
    """
    with open(file_path, 'r') as f:
        for i, line in enumerate(f.readlines()[start_after:], start=start_after + 1):
            if content in line:
                return i
    raise AssertionError(f"Content '{content}' not found in file '{file_path}' after line {start_after}")


# ========== Workflow State Management Functions ==========
# These functions are used by MCP servers for workflow state management

def parse_workflow_json_block(content: str, block_name: str):
    """
    Parse JSON from a DYNAMIC section in workflow_state.md.
    
    Args:
        content: Full file content
        block_name: Block name (e.g., "State", "Metrics")
        
    Returns:
        Parsed JSON (dict/list) or {} if not found
    """
    import re
    
    # Convert block_name to UPPER_SNAKE_CASE
    def camel_to_upper_snake(name: str) -> str:
        out = []
        for i, c in enumerate(name):
            if c.isupper() and i != 0 and (not name[i - 1].isupper()):
                out.append("_")
            out.append(c.upper())
        return "".join(out)
    
    tag = camel_to_upper_snake(block_name)
    start_marker = f"<!-- DYNAMIC:{tag}:START -->"
    end_marker = f"<!-- DYNAMIC:{tag}:END -->"
    
    i = content.find(start_marker)
    if i == -1:
        return {}
    j = content.find(end_marker, i)
    if j == -1:
        return {}
    
    segment = content[i:j]
    
    # Extract ```json ... ``` block
    json_start = segment.find("```json")
    if json_start == -1:
        return {}
    json_start_content = json_start + len("```json")
    json_end = segment.find("```", json_start_content)
    if json_end == -1:
        return {}
    
    raw = segment[json_start_content:json_end].strip()
    
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def read_workflow_state(file_path: Path):
    """
    Read workflow state from file.
    
    Args:
        file_path: Path to workflow_state.md
        
    Returns:
        WorkflowMemory object
    """
    from schemas import WorkflowMemory
    
    if not file_path.exists():
        return WorkflowMemory()
    
    try:
        content = file_path.read_text(encoding="utf-8")
        
        state_data = parse_workflow_json_block(content, "State")
        preconditions_data = parse_workflow_json_block(content, "Preconditions")
        root_causes_data = parse_workflow_json_block(content, "RootCauses")
        parameter_space_data = parse_workflow_json_block(content, "ParameterSpace")
        trigger_plans_data = parse_workflow_json_block(content, "TriggerPlans")
        fuzz_plan_data = parse_workflow_json_block(content, "FuzzPlan")
        breakpoints_data = parse_workflow_json_block(content, "Breakpoints")
        metrics_data = parse_workflow_json_block(content, "Metrics")
        log_data = parse_workflow_json_block(content, "Log")
        
        memory_dict = {
            "state": state_data or {},
            "preconditions": preconditions_data if isinstance(preconditions_data, list) else [],
            "root_causes": root_causes_data if isinstance(root_causes_data, list) else [],
            "parameter_space": parameter_space_data or {},
            "trigger_plans": trigger_plans_data if isinstance(trigger_plans_data, list) else [],
            "fuzz_plan": fuzz_plan_data if isinstance(fuzz_plan_data, list) else [],
            "breakpoints": breakpoints_data if isinstance(breakpoints_data, list) else [],
            "metrics": metrics_data or {},
            "log": log_data if isinstance(log_data, list) else [],
        }
        
        return WorkflowMemory.model_validate(memory_dict)
    except Exception:
        return WorkflowMemory()


def check_tool_permission(phase, tool_name: str) -> bool:
    """
    Check if a tool is allowed in the current workflow phase.
    
    Args:
        phase: Current workflow phase (string or WorkflowPhase enum)
        tool_name: Name of the tool to check
        
    Returns:
        bool: True if tool is allowed in this phase
    """
    from schemas import WorkflowPhase
    
    # Convert string to enum if needed
    if isinstance(phase, str):
        try:
            phase = WorkflowPhase(phase)
        except ValueError:
            return False
    
    # R-PL6: get_reaching_routes, get_corpus_status
    # R-IM5: extract_parameters, get_generator_api_doc
    # R-EX5: fuzz, get_generator_api_doc
    # R-RF5: launch_interactive_gdb
    allowed_tools = {
        WorkflowPhase.PLAN: {
            'get_reaching_routes',
            'get_corpus_status',
        },
        WorkflowPhase.IMPLEMENT: {
            'extract_parameters', 'get_generator_api_doc', 'format_help'
        },
        WorkflowPhase.EXECUTE: {
            'fuzz', 'get_generator_api_doc', 'format_help'
        },
        WorkflowPhase.REFLECT: {
            'launch_interactive_gdb',
        },
        WorkflowPhase.SUCCESS: set(),  # Terminal phase - no tools allowed
    }
    
    return tool_name in allowed_tools.get(phase, set())
