import collections
import json
import logging
import os
import sys
from source_code import SourceCodeFinder

class PromptBuilder:
    """Builder for property-based directed fuzzing prompts following the new agent protocol."""
    
    FIND_POC_SYS_PROMPT = '''# LLM Agent for Finding PoC {project_name}

## Mission
You are an autonomous agent that finds PoC input for bugs in C/C++ programs.
Your goal is to find a PoC input that triggers the bug predicate.

## System Input
You will receive structured input containing:

1. **ENTRY_SOURCE_CODE**: Entry functions (main/FuzzerTestOneInput) and target location functions with line numbers
2. **TARGET_LOCATIONS**: Bug predicate locations with format 'loc=file:line, code=source_line'  
3. **COMMAND LINE**: Command line with arguments for the program under test; use @@ to denote the input file
4. **REACHED_PATTERN**: Pattern to match for reached target
5. **TRIGGERED_PATTERN**: Pattern to match for triggered bug

Use this information to analyze the program, locate the bug predicate, and write a Python script that generates a PoC input which triggers the bug at the target location; the bug should appear in stderr as TRIGGERED_PATTERN.

Save a working PoC input to {poc_path}.
Move your Python script to {gen_path}.

'''

    PROPERTY_BASED_FUZZER_SYS_PROMPT = '''# Security Research Autonomous Agent for {project_name}

## Mission
You are a security expert who understands vulnerabilities in C/C++ programs.
Your goal is to find a PoC input that can reproduce the target vulnerability.

## Configuration-Driven Workflow
**CRITICAL**: Your entire task is defined in two configuration files:

1. **`.cursor/project_config.md`**: Contains complete project context, requirements, constraints, patterns, and technical details
2. **`.cursor/workflow_state.md`**: Contains current workflow rules, phase transitions, and dynamic state

## Startup Protocol
1. **Read Configuration**: Always start by reading both configuration files to understand your full context
2. **Follow Workflow Rules**: All workflow rules and phase transitions are defined in workflow_state.md STATIC sections

## Core Principle
Let the configuration files guide you completely. Don't assume requirements - read them from the config files and follow them exactly.
'''
    
    FIX_PYTHON_GENERATOR_SYS_PROMPT = '''Fix import errors in Python generator code.

Requirements:
1. Add ALL missing import statements at the top
2. Install all the required external libraries by running 'pip install pkg_name' from a shell
3. Keep generate(**params) function logic intact
4. Return ONLY complete corrected code, no explanations, no prose.

Error: {error_message}

Code: {generator_code}
'''
    
    def __init__(self, config, knowledge):
        """Initialize the PromptBuilder with necessary dependencies."""
        self.config = config
        self.logger = logging.getLogger(self.__class__.__qualname__)
        self.code_finder = SourceCodeFinder(config)
        self._func_codes = {}
        
        # Determine project name from binary
        self.project_name = ''
        bin_name = os.path.basename(self.config.cmd[0])
        for project, bins in knowledge["projects"].items():
            for b in bins:
                if b in bin_name:
                    self.project_name = project
                    break
        
        # Initialize private attributes for lazy loading
        self._entry_fn_guids = None
        self._entry_func_names = None  # Set of entry function names
        self._target_locations = None
        self._target_func_names = None  # Set of target function names
        

    @property
    def entry_fn_guids(self):
        """Lazy initialization of entry function GUIDs and names.

        Returns an empty list when static analysis (function_info.txt) is unavailable;
        downstream consumers must tolerate that and skip source-code enrichment.
        """
        if self._entry_fn_guids is None:
            self._entry_fn_guids = []
            self._entry_func_names = set()
            for fn_guid, info in self.code_finder.function_infos.items():
                if "FuzzerTestOneInput" in info[0]:
                    self._entry_fn_guids.append(fn_guid)
                    self._entry_func_names.add(info[0])
                elif info[0] == "main":
                    self._entry_fn_guids.append(fn_guid)
                    self._entry_func_names.add(info[0])
            if not self._entry_fn_guids:
                self.logger.debug(
                    "No entry function found in function_info.txt; running without static enrichment."
                )
        return self._entry_fn_guids

    @property
    def entry_func_names(self):
        """Get entry function names (triggers lazy initialization)."""
        # Access entry_fn_guids to ensure initialization
        _ = self.entry_fn_guids
        return self._entry_func_names or set()

    @property
    def target_locations(self):
        """Lazy initialization of target locations and function names.

        Returns an empty set when BBtargets.txt is missing or static enrichment is unavailable;
        the caller must tolerate that.
        """
        if self._target_locations is None:
            self._target_locations = self._collect_target_locations_from_file()
            self._target_func_names = set()
            for _, _, fn_guid in self._target_locations:
                if fn_guid in self.code_finder.function_infos:
                    func_name = self.code_finder.function_infos[fn_guid][0]
                    self._target_func_names.add(func_name)
            if not self._target_locations:
                self.logger.debug(
                    "No target locations found from BBtargets.txt; PromptBuilder will skip enrichment."
                )
        return self._target_locations

    @property
    def target_func_names(self):
        """Get target function names (triggers lazy initialization)."""
        # Access target_locations to ensure initialization
        _ = self.target_locations
        return self._target_func_names or set()
    
    def get_role(self):
        """Get the system role description for the LLM."""
        return f"You are a security testing agent for property-based directed fuzzing, specializing in the {self.project_name} project."

    def build_find_poc_prompt(self, fuzzer_config):
        """
        Build PoC finding prompt following the same structure as build_prompt.
        
        Args:
            fuzzer_config: Dict containing fuzzer configuration (cmd, patterns, etc.)
            
        Returns:
            Complete prompt string for the LLM to find PoC input
        """
        parts = []
        
        # Load function source codes for entry functions
        for fn_guid in self.entry_fn_guids:
            if fn_guid not in self._func_codes:
                self._func_codes[fn_guid] = self.code_finder.get_function_source_code(fn_guid)
        
        project_info = 'for ' + self.project_name if self.project_name else ' '
        poc_path = os.path.abspath(os.path.join(str(self.config.output_dir), "crashes", "poc"))
        gen_path = os.path.abspath(str(self.config.output_dir))
        # Add the main prompt
        formatted_prompt = self.FIND_POC_SYS_PROMPT.format(
            project_name=project_info, 
            poc_path=poc_path, 
            gen_path=gen_path)
        parts.append(formatted_prompt)
        
        # Add source code blocks
        parts.append("<ENTRY_SOURCE_CODE>\n")
        
        # Collect all function GUIDs to avoid duplicates
        included_func_guids = set()
        file_functions = collections.defaultdict(list)
        
        # Add entry functions
        for fn_guid in self.entry_fn_guids:
            if fn_guid not in included_func_guids:
                included_func_guids.add(fn_guid)
                filepath = self.code_finder.get_fp_from_func_id(fn_guid)
                if filepath:
                    file_functions[filepath].append(fn_guid)
        
        # Output functions grouped by file, sorted by filepath
        for filepath in sorted(file_functions.keys()):
            parts.append(f"/* inside file={filepath} */\n")
            # Sort functions within each file by their start line for consistent ordering
            fn_guids = file_functions[filepath]
            fn_guids_with_lines = []
            for fn_guid in fn_guids:
                try:
                    start_line, _ = self.code_finder.get_func_range_from_func_id(fn_guid)
                    fn_guids_with_lines.append((start_line, fn_guid))
                except:
                    fn_guids_with_lines.append((0, fn_guid))  # fallback for missing line info
            fn_guids_with_lines.sort(key=lambda x: x[0])
            
            for _, fn_guid in fn_guids_with_lines:
                if fn_guid in self._func_codes:
                    source_code = self._get_limited_function_source_code(fn_guid)
                    parts.append(source_code + '\n......\n')

        parts.append("</ENTRY_SOURCE_CODE>\n\n")
        
        # Add target locations
        parts.append("<TARGET_LOCATIONS>\n")
        for loc, line_code, _ in self.target_locations:
            parts.append(f"loc={loc}, code={line_code}\n")
        parts.append("</TARGET_LOCATIONS>\n\n")
        
        # Add command line information
        parts.append("<COMMAND_LINE>\n")
        parts.append(f"{' '.join(fuzzer_config.get('cmd', '').split())}\n")
        parts.append("</COMMAND_LINE>\n\n")
        
        # Add reached pattern information
        parts.append("<REACHED_PATTERN>\n")
        parts.append(f"{fuzzer_config.get('reached_pattern', '')}\n")
        parts.append("</REACHED_PATTERN>\n\n")
        
        # Add triggered pattern information
        parts.append("<TRIGGERED_PATTERN>\n")
        parts.append(f"{fuzzer_config.get('triggered_pattern', '')}\n")
        parts.append("</TRIGGERED_PATTERN>\n\n")
        
        return "".join(parts)

    def build_prompt(self, fuzzer_config):
        """
        Build property-based fuzzing prompt using the workflow system.

        Static-analysis enrichment (entry/target source code) is best-effort; the prompt
        works even when ``function_info.txt`` / ``bid_loc_mapping.txt`` are absent.
        """
        parts = []

        # Best-effort: pre-load source for entry functions only if static analysis exposed them.
        for fn_guid in self.entry_fn_guids:
            if fn_guid not in self._func_codes:
                try:
                    self._func_codes[fn_guid] = self.code_finder.get_function_source_code(fn_guid)
                except Exception as exc:
                    self.logger.debug(f"Skipping source for {fn_guid}: {exc}")

        project_info = 'for ' + self.project_name if self.project_name else ' '
        formatted_prompt = self.PROPERTY_BASED_FUZZER_SYS_PROMPT.format(project_name=project_info)
        parts.append(formatted_prompt)

        parts.append("\n<WORKFLOW_MEMORY>\n")
        parts.append("**CRITICAL**: Read .cursor/workflow_state.md FIRST to understand your current context and phase.\n")
        parts.append("**Configuration**: Complete project context is in .cursor/project_config.md\n")
        parts.append("**Targets**: Read `static_results/BBtargets.txt` for target file:line[,condition_expr] entries.\n")
        parts.append("**State Management**: Use workflow MCP server tools for all state operations\n")
        parts.append("**Autonomous Operation**: Work continuously until mission completion\n")
        parts.append("</WORKFLOW_MEMORY>")

        parts.append(
            "\n<POC_PROTOCOL>\n"
            "When you confirm a PoC that triggers the bug locally, write the bytes to "
            "`<output_dir>/candidate_poc.bin` and `touch <output_dir>/CANDIDATE_READY`. "
            "The wrapper picks these up and forwards the PoC to the green agent for verification.\n"
            "</POC_PROTOCOL>\n"
        )

        return "".join(parts)

    def build_fix_py_prompt(self, error_message: str, generator_code: str) -> str:
        """
        Build a prompt to fix Python generator import errors.
        
        Args:
            error_message: The error message from the failed generator import
            generator_code: The original generator code that failed
            
        Returns:
            Complete prompt string for fixing the Python code
        """
        return self.FIX_PYTHON_GENERATOR_SYS_PROMPT.format(
            error_message=error_message,
            generator_code=generator_code
        )

    def build_source_code_blocks(self) -> str:
        """Build source code blocks for project_config.md"""
        parts = []
        
        # Load function source codes for entry functions
        for fn_guid in self.entry_fn_guids:
            if fn_guid not in self._func_codes:
                self._func_codes[fn_guid] = self.code_finder.get_function_source_code(fn_guid)
        
        # Collect all function GUIDs to avoid duplicates
        included_func_guids = set()
        file_functions = collections.defaultdict(list)
        
        # Add entry functions
        for fn_guid in self.entry_fn_guids:
            if fn_guid not in included_func_guids:
                included_func_guids.add(fn_guid)
                filepath = self.code_finder.get_fp_from_func_id(fn_guid)
                if filepath:
                    file_functions[filepath].append(fn_guid)
                    
        # Add target location functions
        for _, _, fn_guid in self.target_locations:
            if fn_guid not in included_func_guids:
                included_func_guids.add(fn_guid)
                filepath = self.code_finder.get_fp_from_func_id(fn_guid)
                if filepath:
                    file_functions[filepath].append(fn_guid)
        
        # Output functions grouped by file, sorted by filepath
        for filepath in sorted(file_functions.keys()):
            parts.append(f"### File: {filepath}\n")
            # Sort functions within each file by their start line for consistent ordering
            fn_guids = file_functions[filepath]
            fn_guids_with_lines = []
            for fn_guid in fn_guids:
                try:
                    start_line, _ = self.code_finder.get_func_range_from_func_id(fn_guid)
                    fn_guids_with_lines.append((start_line, fn_guid))
                except:
                    fn_guids_with_lines.append((0, fn_guid))  # fallback for missing line info
            fn_guids_with_lines.sort(key=lambda x: x[0])
            
            for _, fn_guid in fn_guids_with_lines:
                if fn_guid in self._func_codes:
                    source_code = self._get_limited_function_source_code(fn_guid)
                    parts.append(f"```c\n{source_code}\n```\n")

        return "".join(parts)

    def build_target_locations_block(self) -> str:
        """Build target locations block for project_config.md"""
        parts = []
        for loc, line_code, _ in self.target_locations:
            parts.append(f"- **Location**: `{loc}`\n")
            parts.append(f"  **Code**: `{line_code}`\n")
        return "".join(parts)

    def build_fuzzer_config_block(self, fuzzer_config: dict) -> str:
        """Build fuzzer config block for project_config.md"""
        return json.dumps(fuzzer_config, indent=2)

    def _collect_target_locations_from_file(self) -> set:
        """
        Read target locations from BBtargets.txt and best-effort locate enclosing functions.

        Format per line: ``relative/path.c:LINE`` with optional ``,condition_expr`` suffix.
        Lines starting with ``#`` and blank lines are ignored.
        Returns a set of ``(loc, line_code, fn_guid)`` tuples; ``fn_guid`` is ``None`` and
        ``line_code`` is ``""`` when static-analysis enrichment is unavailable.
        """
        targets_info = set()
        fp = os.path.join(self.config.static_result_folder, "BBtargets.txt")
        target_loc = set()
        try:
            with open(fp, 'r') as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith("#"):
                        continue
                    loc = line.split(",", 1)[0].strip()
                    if ":" in loc:
                        target_loc.add(loc)
        except Exception as e:
            self.logger.debug(f"BBtargets.txt unavailable for enrichment: {e}")
            return targets_info
        if not target_loc:
            return targets_info

        for loc in target_loc:
            try:
                fn_guids = self.code_finder.get_func_ids_from_loc(loc)
            except Exception:
                fn_guids = []
            if not fn_guids:
                targets_info.add((loc, "", None))
                continue
            for fn_guid in fn_guids:
                if fn_guid not in self._func_codes:
                    try:
                        self._func_codes[fn_guid] = self.code_finder.get_function_source_code(fn_guid)
                    except Exception:
                        self._func_codes[fn_guid] = ""
                try:
                    line_number = int(loc.split(":")[1])
                    file_path = self.code_finder.get_fp_from_func_id(fn_guid)
                    line_code = self.code_finder.get_code_line(file_path, line_number) if file_path else ""
                except Exception:
                    line_code = ""
                targets_info.add((loc, line_code.strip(), fn_guid))
        return targets_info

    def _get_limited_function_source_code(self, fn_guid: int) -> str:
        """
        Get function source code with 500-line limit for target functions.
        If the function contains target lines and is over 500 lines, only return 
        the 500 lines before the latest target line to ensure all target lines are included.
        
        Args:
            fn_guid: Function GUID
            
        Returns:
            Limited source code string
        """
        if fn_guid not in self._func_codes:
            return ""
            
        full_source_code = self._func_codes[fn_guid]
        source_lines = full_source_code.split('\n')
        
        # If function is under 500 lines, return as is
        if len(source_lines) <= 500:
            return full_source_code
            
        # Check if this function contains any target lines
        target_lines_in_function = []
        try:
            func_start_line, func_end_line = self.code_finder.get_func_range_from_func_id(fn_guid)
            
            for loc, _, target_fn_guid in self.target_locations:
                if target_fn_guid == fn_guid:
                    target_line_num = int(loc.split(":")[1])
                    # Convert absolute line number to relative line number within function
                    relative_line = target_line_num - func_start_line
                    if 0 <= relative_line < len(source_lines):
                        target_lines_in_function.append(relative_line)
        except Exception as e:
            self.logger.warning(f"Could not determine target lines for function {fn_guid}: {e}")
            # If we can't determine target lines, just return last 500 lines
            return '\n'.join(source_lines[-500:])
        
        # If no target lines in this function, return as is
        if not target_lines_in_function:
            return full_source_code
            
        # Find the latest target line to ensure all target lines are included
        latest_target_line = max(target_lines_in_function)
        
        # Calculate the range: 500 lines ending at the latest target line
        # But ensure we don't go beyond the function boundaries
        end_line = min(latest_target_line + 1, len(source_lines))  # +1 because we want to include the target line
        start_line = max(0, end_line - 500)
        
        # Edge case: if we have multiple target lines, ensure the earliest one is included
        if len(target_lines_in_function) > 1:
            earliest_target_line = min(target_lines_in_function)
            # If the earliest target line would be cut off, adjust the range
            if earliest_target_line < start_line:
                # Try to include all target lines within 500 lines
                range_needed = latest_target_line - earliest_target_line + 1
                if range_needed <= 500:
                    # We can fit all target lines, center the range around them
                    mid_point = (earliest_target_line + latest_target_line) // 2
                    start_line = max(0, mid_point - 250)
                    end_line = min(len(source_lines), start_line + 500)
                    # Adjust start_line if we hit the end boundary
                    start_line = max(0, end_line - 500)
                else:
                    # Target lines span more than 500 lines, include range from earliest to latest target line
                    start_line = max(0, earliest_target_line)
                    end_line = min(len(source_lines), latest_target_line + 1)
        
        limited_lines = source_lines[start_line:end_line]
        
        # Add a comment indicating this is a truncated view
        if start_line > 0 or end_line < len(source_lines):
            func_name = "unknown"
            try:
                func_name = self.code_finder.get_func_name_from_func_id(fn_guid)
            except:
                pass
            prefix = f"/* Function '{func_name}' truncated: showing lines {start_line + 1}-{end_line} of {len(source_lines)} total lines */\n"
            return prefix + '\n'.join(limited_lines)
        
        return '\n'.join(limited_lines)
