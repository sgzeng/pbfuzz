#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# Property-based fuzzer driver
# -----------------------------------------------------------------------------

import json, sys, random, time, subprocess, re, logging, ast, os
import importlib.util
import threading
from pathlib import Path
from typing import Dict, List, Any, Optional, Callable, Tuple, Union
from config import Config
from debugger import RuntimeDebugger
import utils
# Import Pydantic models
from schemas import FuzzResult, IterationResult, FuzzSummary

AT_FILE = "@@"

class GeneratorImportError(Exception):
    """Custom exception for generator import/execution errors."""
    pass

class GeneratorTimeoutError(Exception):
    """Custom exception for generator function timeout."""
    pass

class PropertyBasedFuzzer:
    """Property-based fuzzer with debugger integration."""
    
    def __init__(self, config: Config):
        """Initialize the fuzzer with configuration.
        
        Args:
            config: Configuration object from config.py, optional
        """
        self.logger = logging.getLogger(self.__class__.__name__)
        self.config = config
        self.use_debugger = False
        self._debugger_instance = None
        
        # Handle output_dir as either Path or string
        if hasattr(self.config.output_dir, '__truediv__'):  # Check if it's a Path-like object
            self.crashes_dir = self.config.output_dir / "crashes"
            self.queue_dir = self.config.output_dir / "queue"
            self.testcases_dir = self.config.output_dir / "testcases"
            self.generator_dir = self.config.output_dir / "generators"
            self.plan_dir = self.config.output_dir / "plans"
            self.fuzz_results_dir = self.config.output_dir / "fuzz_results"
            self.error_log_file = self.config.output_dir / "pbf_error.log"
        else:  # Handle string paths
            self.crashes_dir = Path(self.config.output_dir) / "crashes"
            self.queue_dir = Path(self.config.output_dir) / "queue"
            self.testcases_dir = Path(self.config.output_dir) / "testcases"
            self.generator_dir = Path(self.config.output_dir) / "generators"
            self.plan_dir = Path(self.config.output_dir) / "plans"
            self.fuzz_results_dir = Path(self.config.output_dir) / "fuzz_results"
            self.error_log_file = Path(self.config.output_dir) / "pbf_error.log"
        self.crashes_dir.mkdir(parents=True, exist_ok=True)
        self.queue_dir.mkdir(parents=True, exist_ok=True)
        self.testcases_dir.mkdir(parents=True, exist_ok=True)
        self.generator_dir.mkdir(parents=True, exist_ok=True)
        
        # check files in self.plan_dir. try to get the max round number by iterating plan_{i}.json
        max_round = 0
        for file in self.plan_dir.glob("plan_*.json"):
            parts = file.stem.split("_")
            if len(parts) == 2 and parts[1].isdigit():
                round_number = int(parts[1])
                max_round = max(max_round, round_number)
        # Internal round counter - automatically increments with each fuzz() call
        self.round = max_round
        
        # Set debugger preference from config if available
        self.use_debugger = config.enable_debugger_for_all
        # Try to initialize debugger early if enabled to catch import errors
        if self.use_debugger:
            _ = self.debugger_instance
        
        # Cache for loaded generators to avoid reloading
        self._generator_cache = {}
        self.plan_dir.mkdir(parents=True, exist_ok=True)
        self.fuzz_results_dir.mkdir(parents=True, exist_ok=True)
        
        self.logger.debug(f"PropertyBasedFuzzer initialized with debugger={'enabled' if self.use_debugger else 'disabled'}")
    
    @property
    def debugger_instance(self):
        if self._debugger_instance is None:
            try:
                self._debugger_instance = RuntimeDebugger(self.config)
            except Exception as e:
                self._log_error_to_file(f"Error initializing debugger: {e}", "debugger_init")
                self._debugger_instance = None
                # If debugger initialization fails, disable debugger usage
                self.use_debugger = False
        return self._debugger_instance
    
    def _log_error_to_file(self, message: str, stage: str = "unknown") -> None:
        """
        Log error/warning messages to error.log file for later retrieval by agent.
        
        Args:
            message: Error message to log
            stage: Stage where error occurred (e.g., 'generator_import', 'auto_fix', etc.)
        """
        utils.log_error_to_file(self.error_log_file, message, stage, "property_fuzzer", self.logger)
    
    def _run_generator_with_timeout(self, generate_func: Callable, exec_timeout_sec: float, **params) -> Tuple[Any, Dict[str, Any]]:
        """
        Run generator function with timeout protection.
        
        Args:
            generate_func: The generator function to call
            exec_timeout_sec: Timeout in seconds
            **params: Parameters to pass to the generator function
            
        Returns:
            Tuple of (data, used_params) from generator function
            
        Raises:
            GeneratorTimeoutError: If generator function times out
            Exception: Any exception raised by the generator function
        """
        result: List[Optional[Tuple[Any, Dict[str, Any]]]] = [None]  # Use list to allow modification in nested function
        exception: List[Optional[Exception]] = [None]
        
        def target():
            try:
                result[0] = generate_func(**params)
            except Exception as e:
                exception[0] = e
        
        # Create and start thread
        thread = threading.Thread(target=target)
        thread.daemon = True  # Daemon thread will be killed when main thread exits
        thread.start()
        
        # Wait for completion or timeout
        thread.join(exec_timeout_sec)
        
        if thread.is_alive():
            # Thread is still running, timeout occurred
            self._log_error_to_file(f"Generator function timed out after {exec_timeout_sec} seconds", "generator_timeout")
            raise GeneratorTimeoutError(f"Generator function timed out after {exec_timeout_sec} seconds")
        
        # Check if an exception occurred in the thread
        if exception[0] is not None:
            raise exception[0]
        
        # Return the result
        if result[0] is None:
            raise RuntimeError("Generator function returned None unexpectedly")
        return result[0]
    
    def _inject_common_imports(self, generator_code: str) -> str:
        """
        Pre-inject common imports at the beginning of generator code.
        This avoids costly error handling during module loading.
        
        Args:
            generator_code: Original generator code
            
        Returns:
            Generator code with common imports added
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
            "import numpy as np"
        ]
        
        # Use unified import insertion logic
        result_code = generator_code
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
        Unified logic for both common imports and auto-fix imports.
        
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
    
    def _load_dynamic_generator(self, cur_round: int):
        """
        Dynamically load generator function for the current round.
        
        Args:
            cur_round: Current round number
            
        Returns:
            Generator function if found and valid
            
        Raises:
            GeneratorImportError: If generator cannot be imported or is invalid
        """
        # Check cache first
        if cur_round in self._generator_cache:
            self.logger.debug(f"Using cached generator for round {cur_round}")
            return self._generator_cache[cur_round]
        
        generator_file = self.generator_dir / f"gen_{cur_round}.py"
        
        if not generator_file.exists():
            raise GeneratorImportError(f"Generator file not found: {generator_file}")
        
        try:
            # Create unique module name to avoid caching issues
            module_name = f"gen_{cur_round}_{int(time.time() * 1000000)}"
            
            # Load module dynamically
            spec = importlib.util.spec_from_file_location(module_name, generator_file)
            if spec is None or spec.loader is None:
                raise GeneratorImportError(f"Failed to create module spec for {generator_file}")
            
            module = importlib.util.module_from_spec(spec)
            
            # Execute module - common imports should already be injected
            try:
                spec.loader.exec_module(module)
            except NameError as ne:
                # Fallback: Handle missing imports if pre-injection missed something
                self._log_error_to_file(f"NameError despite pre-injection in {generator_file}: {ne}", "generator_import")
                if self._auto_fix_missing_imports(generator_file, str(ne)):
                    # Reload after fixing
                    new_spec = importlib.util.spec_from_file_location(f"{module_name}_fixed", generator_file)
                    if new_spec and new_spec.loader:
                        new_module = importlib.util.module_from_spec(new_spec)
                        new_spec.loader.exec_module(new_module)
                        module = new_module
                    else:
                        raise GeneratorImportError(f"Failed to reload after auto-fix for {generator_file}")
                else:
                    raise GeneratorImportError(f"Failed to auto-fix missing imports in {generator_file}: {ne}")
            
            # Check if generate function exists
            if not hasattr(module, 'generate'):
                raise GeneratorImportError(f"No 'generate' function found in {generator_file}")
            
            generate_func = getattr(module, 'generate')
            
            # Basic validation - check if it's callable
            if not callable(generate_func):
                raise GeneratorImportError(f"'generate' in {generator_file} is not callable")
            
            # Skip test call in production - pre-injection should handle most cases
            # This significantly reduces overhead since test calls can be expensive
            if self.logger.isEnabledFor(logging.DEBUG):
                # Only do test call in debug mode for validation
                test_params = {"seed": 0}
                try:
                    generate_func(**test_params)
                    self.logger.debug(f"Generator test call succeeded for {generator_file}")
                except NameError as ne:
                    # In debug mode, try to fix and continue
                    self._log_error_to_file(f"NameError in test call: {ne}", "generator_test")
                    if self._auto_fix_missing_imports(generator_file, str(ne)):
                        # Reload after fixing
                        new_spec = importlib.util.spec_from_file_location(f"{module_name}_fixed", generator_file)
                        if new_spec and new_spec.loader:
                            new_module = importlib.util.module_from_spec(new_spec)
                            new_spec.loader.exec_module(new_module)
                            if hasattr(new_module, 'generate'):
                                generate_func = getattr(new_module, 'generate')
                except Exception as e:
                    # Other errors are expected (missing params, etc)
                    self.logger.debug(f"Test call other error (expected): {e}")
            
            self.logger.debug(f"Successfully loaded generator from {generator_file}")
            
            # Cache the loaded generator
            self._generator_cache[cur_round] = generate_func
            
            return generate_func
            
        except Exception as e:
            if isinstance(e, GeneratorImportError):
                raise
            else:
                raise GeneratorImportError(f"Error loading generator from {generator_file}: {str(e)}")
    
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
        
        # Special handling for copy imports
        if undefined_name == 'deepcopy':
            if re.search(r'from copy import[^\n]*\bdeepcopy\b', content):
                return True
        
        # Special handling for dataclass imports
        dataclass_names = {'dataclass', 'field'}
        if undefined_name in dataclass_names:
            pattern = rf'from dataclasses import[^\n]*\b{re.escape(undefined_name)}\b'
            if re.search(pattern, content):
                return True
        
        # Special handling for unittest.mock imports
        mock_names = {'Mock', 'MagicMock', 'patch'}
        if undefined_name in mock_names:
            pattern = rf'from unittest\.mock import[^\n]*\b{re.escape(undefined_name)}\b'
            if re.search(pattern, content):
                return True
        
        # Check for module alias imports (e.g., 'np' for numpy)
        alias_patterns = {
            'np': r'import numpy as np',
            'pd': r'import pandas as pd',
            'plt': r'import matplotlib\.pyplot as plt',
            'sns': r'import seaborn as sns',
        }
        
        if undefined_name in alias_patterns:
            if re.search(alias_patterns[undefined_name], content):
                return True
        
        # Check for module imports that could satisfy the undefined name
        module_patterns = {
            'Path': r'from pathlib import Path',
            'pp': r'from pprint import pprint as pp',
        }
        
        if undefined_name in module_patterns:
            if re.search(module_patterns[undefined_name], content):
                return True
        
        return False

    def _insert_import_smartly(self, content: str, undefined_name: str, import_statement: str) -> str:
        """
        Insert import statement intelligently, handling merging and proper positioning.
        
        Args:
            content: Original file content
            undefined_name: The name that was undefined
            import_statement: The import statement to add
            
        Returns:
            Modified content with import added
        """
        # Try to merge with existing imports first
        merged_content = self._try_merge_import(content, undefined_name, import_statement)
        if merged_content != content:
            return merged_content
        
        # If no merge possible, use standard insertion
        return self._insert_import_at_position(content, import_statement)
    
    def _try_merge_import(self, content: str, undefined_name: str, import_statement: str) -> str:
        """
        Try to merge import with existing similar imports.
        
        Args:
            content: Original file content
            undefined_name: The name that was undefined
            import_statement: The import statement to add
            
        Returns:
            Modified content if merge successful, original content otherwise
        """
        lines = content.split('\n')
        
        # Define mergeable import groups
        typing_names = {'Dict', 'Any', 'Tuple', 'List', 'Optional', 'Union', 'Set', 
                       'Callable', 'Iterator', 'Iterable', 'Generator', 'Type', 
                       'ClassVar', 'Final', 'Literal', 'TypeVar', 'Generic', 'Protocol', 'typing'}
        collections_names = {'namedtuple', 'defaultdict', 'Counter', 'OrderedDict', 'deque', 'ChainMap'}
        dataclass_names = {'dataclass', 'field'}
        
        # Try typing imports merge
        if undefined_name in typing_names:
            for i, line in enumerate(lines):
                if line.strip().startswith('from typing import'):
                    match = re.search(r'from typing import (.+)', line.strip())
                    if match:
                        current_imports = [imp.strip() for imp in match.group(1).split(',')]
                        new_imports_match = re.search(r'from typing import (.+)', import_statement)
                        if new_imports_match:
                            new_imports = [imp.strip() for imp in new_imports_match.group(1).split(',')]
                            all_imports = list(dict.fromkeys(current_imports + new_imports))
                            lines[i] = f"from typing import {', '.join(all_imports)}"
                            return '\n'.join(lines)
        
        # Try collections imports merge
        if undefined_name in collections_names:
            for i, line in enumerate(lines):
                if line.strip().startswith('from collections import'):
                    match = re.search(r'from collections import (.+)', line.strip())
                    if match:
                        current_imports = [imp.strip() for imp in match.group(1).split(',')]
                        if undefined_name not in current_imports:
                            current_imports.append(undefined_name)
                            lines[i] = f"from collections import {', '.join(current_imports)}"
                            return '\n'.join(lines)
        
        # Try dataclasses imports merge
        if undefined_name in dataclass_names:
            for i, line in enumerate(lines):
                if line.strip().startswith('from dataclasses import'):
                    match = re.search(r'from dataclasses import (.+)', line.strip())
                    if match:
                        current_imports = [imp.strip() for imp in match.group(1).split(',')]
                        if undefined_name not in current_imports:
                            current_imports.append(undefined_name)
                            lines[i] = f"from dataclasses import {', '.join(current_imports)}"
                            return '\n'.join(lines)
        
        return content  # No merge possible
    
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
        is_third_party = any(module in import_statement for module in [
            'numpy', 'pandas', 'matplotlib', 'scipy', 'sklearn', 'seaborn',
            'requests', 'flask', 'django', 'fastapi', 'pytest'
        ])
        
        # Track different import sections
        last_stdlib_import = -1
        last_from_import = -1
        last_typing_import = -1
        last_third_party_import = -1
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
                elif any(module in stripped for module in ['numpy', 'pandas', 'requests', 'flask']):
                    last_third_party_import = i
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
        elif is_third_party and last_third_party_import >= 0:
            return last_third_party_import + 1
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

    def _validate_import_fix(self, original_content: str, new_content: str, import_statement: str) -> bool:
        """
        Validate that the import fix is reasonable and safe.
        
        Args:
            original_content: Original file content
            new_content: Modified content with import added
            import_statement: The import statement that was added
            
        Returns:
            True if the fix looks valid, False otherwise
        """
        # Basic sanity checks
        if not new_content or len(new_content) < len(original_content):
            return False
        
        # Check that the import statement actually appears in the new content
        if import_statement not in new_content:
            return False
        
        # Check that we didn't accidentally break the file structure
        original_lines = original_content.split('\n')
        new_lines = new_content.split('\n')
        
        # The new content should have at most a few more lines than the original
        if len(new_lines) > len(original_lines) + 5:
            return False
        
        # Check that non-import lines are preserved
        original_non_import_lines = [line for line in original_lines 
                                   if line.strip() and not line.strip().startswith(('import ', 'from '))]
        new_non_import_lines = [line for line in new_lines 
                              if line.strip() and not line.strip().startswith(('import ', 'from '))]
        
        # Most non-import lines should be preserved
        if len(new_non_import_lines) < len(original_non_import_lines):
            return False
        
        return True

    def _auto_fix_missing_imports(self, generator_file, error_msg: str) -> bool:
        """
        Automatically detect and fix missing imports in generator files.
        
        Args:
            generator_file: Path to the generator file
            error_msg: The NameError message
            
        Returns:
            True if imports were successfully added, False otherwise
        """
        
        # Common modules that might be missing
        common_modules = {
            # Standard library - core
            'random': 'import random',
            'os': 'import os',
            'sys': 'import sys',
            'json': 'import json',
            'time': 'import time',
            'math': 'import math',
            'string': 'import string',
            'itertools': 'import itertools',
            'collections': 'import collections',
            'functools': 'import functools',
            'datetime': 'import datetime',
            'pathlib': 'from pathlib import Path',
            'Path': 'from pathlib import Path',
            
            # Standard library - extended
            'sqlite3': 'import sqlite3',
            'queue': 'import queue',
            'Queue': 'import queue',
            'heapq': 'import heapq',
            'shutil': 'import shutil',
            'glob': 'import glob',
            
            # Cryptography and encoding
            'struct': 'import struct',
            'hashlib': 'import hashlib',
            'base64': 'import base64',
            'zlib': 'import zlib',
            'gzip': 'import gzip',
            
            # Regular expressions and text processing
            're': 'import re',
            'regex': 'import regex',
            
            # Typing system
            'typing': 'from typing import Dict, Any, Tuple, List, Optional',
            'Dict': 'from typing import Dict, Any, Tuple, List, Optional',
            'Any': 'from typing import Dict, Any, Tuple, List, Optional',
            'Tuple': 'from typing import Dict, Any, Tuple, List, Optional',
            'List': 'from typing import Dict, Any, Tuple, List, Optional',
            'Optional': 'from typing import Dict, Any, Tuple, List, Optional',
            'Union': 'from typing import Dict, Any, Tuple, List, Optional, Union',
            'Set': 'from typing import Dict, Any, Tuple, List, Optional, Set',
            'Callable': 'from typing import Dict, Any, Tuple, List, Optional, Callable',
            'Iterator': 'from typing import Dict, Any, Tuple, List, Optional, Iterator',
            'Iterable': 'from typing import Dict, Any, Tuple, List, Optional, Iterable',
            'Generator': 'from typing import Dict, Any, Tuple, List, Optional, Generator',
            'Type': 'from typing import Dict, Any, Tuple, List, Optional, Type',
            'ClassVar': 'from typing import Dict, Any, Tuple, List, Optional, ClassVar',
            'Final': 'from typing import Dict, Any, Tuple, List, Optional, Final',
            'Literal': 'from typing import Dict, Any, Tuple, List, Optional, Literal',
            'TypeVar': 'from typing import Dict, Any, Tuple, List, Optional, TypeVar',
            'Generic': 'from typing import Dict, Any, Tuple, List, Optional, Generic',
            'Protocol': 'from typing import Dict, Any, Tuple, List, Optional, Protocol',
            
            # Scientific computing
            'numpy': 'import numpy as np',
            'np': 'import numpy as np',
            'pandas': 'import pandas as pd',
            'pd': 'import pandas as pd',
            'matplotlib': 'import matplotlib.pyplot as plt',
            'plt': 'import matplotlib.pyplot as plt',
            'scipy': 'import scipy',
            'sklearn': 'import sklearn',
            'seaborn': 'import seaborn as sns',
            'sns': 'import seaborn as sns',

            
            # Common submodule combinations (for AttributeError fixes)
            'os_path': 'import os.path',
            'urllib_parse': 'import urllib.parse',
            'urllib_request': 'import urllib.request',
            'urllib_error': 'import urllib.error',
            'json_loads': 'import json',
            'json_dumps': 'import json',
            'datetime_datetime': 'import datetime',
            'collections_abc': 'import collections.abc',
            'importlib_util': 'import importlib.util',
            'importlib_metadata': 'import importlib.metadata',
        }
        
        # Extract the undefined name from various error message patterns
        undefined_name = None
        
        # Pattern 1: NameError - "name 'module_name' is not defined"
        if "NameError" in error_msg or "name '" in error_msg:
            match = re.search(r"name '([^']+)' is not defined", error_msg)
            if match:
                undefined_name = match.group(1)
        
        # Pattern 2: ModuleNotFoundError - "No module named 'module_name'"
        elif "ModuleNotFoundError" in error_msg or "No module named" in error_msg:
            match = re.search(r"No module named '([^']+)'", error_msg)
            if match:
                undefined_name = match.group(1)
        
        # Pattern 3: SyntaxError or other specific patterns
        elif "SyntaxError" in error_msg:
            # Look for common syntax errors that might indicate missing imports
            if "invalid syntax" in error_msg.lower():
                # Try to extract potential module names from the error context
                words = re.findall(r'\b[a-zA-Z_][a-zA-Z0-9_]*\b', error_msg)
                for word in words:
                    if word in common_modules and word not in ['invalid', 'syntax', 'error']:
                        undefined_name = word
                        break
        
        if not undefined_name:
            self._log_error_to_file(f"Could not parse error message: {error_msg}", "auto_fix")
            self.logger.debug(f"Full error message for debugging: {repr(error_msg)}")
            return False
        
        if undefined_name not in common_modules:
            self._log_error_to_file(f"Unknown module '{undefined_name}', cannot auto-fix", "auto_fix")
            self.logger.debug(f"Available modules: {', '.join(sorted(common_modules.keys())[:10])}...")
            return False
        
        # Create backup of original content for error recovery
        original_content = None
        backup_created = False
        
        try:
            # Read the current file content
            with open(generator_file, 'r', encoding='utf-8') as f:
                original_content = f.read()
            
            import_statement = common_modules[undefined_name]
            self.logger.debug(f"Attempting to add import: {import_statement}")
            
            # Smart import detection - check if import already exists
            if self._is_import_already_present(original_content, undefined_name, import_statement):
                self.logger.debug(f"Import for '{undefined_name}' already exists in {generator_file}")
                return True
            
            # Smart import insertion with merging and proper positioning
            new_content = self._insert_import_smartly(original_content, undefined_name, import_statement)
            
            # Validate the new content before writing
            if not self._validate_import_fix(original_content, new_content, import_statement):
                self._log_error_to_file(f"Import fix validation failed for {generator_file}", "auto_fix")
                return False
            
            # Create backup before modifying
            backup_file = f"{generator_file}.backup"
            try:
                with open(backup_file, 'w', encoding='utf-8') as f:
                    f.write(original_content)
                backup_created = True
                self.logger.debug(f"Created backup: {backup_file}")
            except Exception as backup_error:
                self._log_error_to_file(f"Could not create backup file: {backup_error}", "auto_fix")
                # Continue without backup
            
            # Write the modified content back to the file
            with open(generator_file, 'w', encoding='utf-8') as f:
                f.write(new_content)
            
            # Verify the fix by attempting a basic syntax check
            try:
                ast.parse(new_content)
                self.logger.info(f"Auto-fixed missing import: added '{import_statement}' to {generator_file}")
                
                # Clean up backup if successful
                if backup_created:
                    try:
                        os.remove(backup_file)
                        self.logger.debug(f"Removed backup file: {backup_file}")
                    except:
                        pass  # Ignore backup cleanup errors
                        
                return True
                
            except SyntaxError as syntax_error:
                self._log_error_to_file(f"Import fix introduced syntax error: {syntax_error}", "auto_fix")
                # Restore from backup
                if backup_created and original_content:
                    try:
                        with open(generator_file, 'w', encoding='utf-8') as f:
                            f.write(original_content)
                        self.logger.info(f"Restored original content from backup")
                    except Exception as restore_error:
                        self._log_error_to_file(f"Failed to restore from backup: {restore_error}", "auto_fix")
                return False
            
        except FileNotFoundError:
            self._log_error_to_file(f"Generator file not found: {generator_file}", "auto_fix")
            return False
        except PermissionError:
            self._log_error_to_file(f"Permission denied accessing file: {generator_file}", "auto_fix")
            return False
        except UnicodeDecodeError as decode_error:
            self._log_error_to_file(f"Unicode decode error reading {generator_file}: {decode_error}", "auto_fix")
            return False
        except Exception as e:
            self._log_error_to_file(f"Failed to auto-fix imports in {generator_file}: {e}", "auto_fix")
            self.logger.debug(f"Exception details: {type(e).__name__}: {str(e)}")
            
            # Attempt to restore from backup if something went wrong
            if backup_created and original_content:
                try:
                    with open(generator_file, 'w', encoding='utf-8') as f:
                        f.write(original_content)
                    self.logger.info(f"Restored original content due to error")
                except Exception as restore_error:
                    self._log_error_to_file(f"Failed to restore from backup: {restore_error}", "auto_fix")
            
            return False
    
    def _parse_runtime_config(self, runtime_config: Dict[str, Any]) -> None:
        """Parse runtime configuration."""
        # Parse config (no defaults; expect keys present)
        self.cmd_template = runtime_config["cmd"]
        self.timeout_s = runtime_config["exec_timeout_sec"]
        # Default: match lines like "Bug <any string with length < 20> reached/triggered"
        # ".{0,19}" means any string with length from 0 up to 19 characters
        self.reached_pat = re.compile(runtime_config["reached_pattern"])
        self.triggered_pat = re.compile(runtime_config["triggered_pattern"])
        self.generator_timeout_sec = runtime_config.get("generator_timeout_sec", 2)
        self.fuzz_timeout_sec = runtime_config.get("fuzz_timeout_sec", 30.0)
    
    @staticmethod
    def _load_json_if(path: Path, default):
        """Load JSON file if it exists, otherwise return default."""
        if path.exists():
            with path.open("r", encoding="utf-8") as f:
                return json.load(f)
        return default
    
    
    @staticmethod
    def _sample_from_space(param_space: Dict[str, Any], seed: int) -> Dict[str, Any]:
        """Sample parameters from parameter space using given seed.
        
        Heuristic: with small probability, pick edge-case values that are likely
        to trigger bugs (boundary values, overflow-like extremes, tricky floats),
        while strictly respecting the given type and range constraints.
        """
        iteration = seed
        random.seed(seed)
        params: Dict[str, Any] = {"seed": seed}

        # Probability to use heuristic selection instead of pure random
        heuristic_prob = 0.01 * iteration

        # Predefined extreme values for integers (32/64-bit boundaries)
        INT32_MIN, INT32_MAX = -(2**31), 2**31 - 1
        INT64_MIN, INT64_MAX = -(2**63), 2**63 - 1
        UINT32_MAX, UINT64_MAX = 2**32 - 1, 2**64 - 1

        # Predefined extreme values for floats (stay finite)
        HUGE_POS, HUGE_NEG = 1e308, -1e308
        TINY_POS, TINY_NEG = 1e-308, -1e-308
        MACHINE_EPS = 2.220446049250313e-16

        def pick_int(spec: Dict[str, Any]) -> int:
            lo = int(spec.get("min", 0))
            hi = int(spec.get("max", 100))

            # Build candidate edge values and filter to range
            raw_candidates = [
                lo, hi,
                lo + 1 if lo < hi else lo,
                hi - 1 if lo < hi else hi,
                -1, 0, 1,
                INT32_MIN, INT32_MAX,
                INT64_MIN, INT64_MAX,
                UINT32_MAX, UINT64_MAX,
            ]
            # Filter candidates to ensure they are within [lo, hi] range
            valid_candidates = [c for c in raw_candidates if lo <= c <= hi]
            
            if random.random() < heuristic_prob and valid_candidates:
                return random.choice(valid_candidates)
            return random.randint(lo, hi)

        def pick_float(spec: Dict[str, Any]) -> float:
            lo = float(spec.get("min", 0.0))
            hi = float(spec.get("max", 1.0))
            if lo > hi:
                lo, hi = hi, lo

            span = hi - lo
            # Construct candidate edge values; keep them finite and within [lo, hi]
            near_lo = lo + max(span * 1e-12, MACHINE_EPS) if span > 0 else lo
            near_hi = hi - max(span * 1e-12, MACHINE_EPS) if span > 0 else hi
            raw_candidates = [
                lo, hi,
                near_lo, near_hi,
                -0.0, 0.0,
                HUGE_NEG, HUGE_POS,
                TINY_NEG, TINY_POS,
            ]
            # Filter candidates to ensure they are within [lo, hi] range
            valid_candidates = [c for c in raw_candidates if lo <= c <= hi]

            if random.random() < heuristic_prob and valid_candidates:
                return random.choice(valid_candidates)
            return random.uniform(lo, hi)

        def pick_categorical(spec: Dict[str, Any]):
            values = spec.get("values", ["default"])  # must choose from provided values
            if not isinstance(values, list) or not values:
                return "invalid_categorical_values"

            # Type analysis to determine what types are present in values
            has_strings = any(isinstance(v, str) for v in values)
            has_ints = any(isinstance(v, int) for v in values)
            has_floats = any(isinstance(v, float) for v in values)
            has_bools = any(isinstance(v, bool) for v in values)
            has_none = None in values

            # Build type-specific buggy value lists
            buggy_candidates = []
            
            if has_strings:
                string_buggy_values = [
                    # Basic edge cases
                    "", " ", "\t", "\n", "\r", "\x00", "\x01", "\x02", "\x03",
                    # String representations of special values
                    "null", "NULL", "Null", "nil", "NIL", "undefined", "UNDEFINED",
                    "NaN", "nan", "NAN", "inf", "INF", "infinity", "INFINITY",
                    "-inf", "-INF", "-infinity", "-INFINITY",
                    # Very long strings
                    "A" * 256, "A" * 1000, "A" * 4096, "A" * 65536,
                    # Path traversal
                    "..", "../", "../../", "../../../etc/passwd", "/etc/passwd",
                    # Injection payloads
                    "<script>alert('xss')</script>", "'; DROP TABLE users; --",
                    "' OR '1'='1", "admin'--", "; cat /etc/passwd", "`ls`",
                    # Format strings
                    "%s", "%x", "%n", "%p", "%d", "%s%s%s%s%s",
                    # Library-specific payloads for libpng, libsndfile, libtiff, etc.
                    # PNG magic bytes and malformed headers
                    "\x89PNG\r\n\x1a\n", "\x89PNG", "PNG\r\n\x1a\n", "\x00\x00\x00\x0dIHDR",
                    # TIFF magic bytes
                    "II*\x00", "MM\x00*", "II+\x00", "MM\x00+",
                    # XML/HTML for libxml2 and poppler
                    "<?xml version='1.0'?>", "<!DOCTYPE html>", "<!ENTITY xxe SYSTEM 'file:///etc/passwd'>",
                    # Lua injection
                    "os.execute('ls')", "io.popen('cat /etc/passwd')", "loadstring('return 1+1')()",
                    # OpenSSL/crypto related
                    "-----BEGIN CERTIFICATE-----", "-----BEGIN PRIVATE KEY-----", "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC",
                    # PHP injection
                    "<?php system('ls'); ?>", "<?=`ls`?>", "eval($_GET['cmd'])",
                    # SQLite specific
                    "PRAGMA table_info(sqlite_master)", "SELECT sql FROM sqlite_master",
                    # Audio file headers for libsndfile
                    "RIFF", "WAVE", "fmt ", "data", "OggS", "fLaC",
                ]
                buggy_candidates.extend([v for v in string_buggy_values if v in values])
            
            if has_ints:
                int_buggy_values = [
                    # Predefined extreme values from above
                    INT32_MIN, INT32_MAX, INT64_MIN, INT64_MAX, UINT32_MAX, UINT64_MAX,
                    # Common edge cases
                    -1, 0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128,
                    255, 256, 511, 512, 1023, 1024, 2047, 2048, 4095, 4096,
                    8191, 8192, 16383, 16384, 32767, 32768, 65535, 65536,
                    # Library-specific values
                    # PNG dimensions and chunk sizes
                    2147483647, 4294967295,  # Max dimensions
                    # Audio sample rates and bit depths
                    8000, 11025, 22050, 44100, 48000, 96000, 192000,  # Sample rates
                    8, 16, 24, 32,  # Bit depths
                    # Image dimensions that might cause issues
                    0, 1, 2, 3, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192,
                ]
                buggy_candidates.extend([v for v in int_buggy_values if v in values])
            
            if has_floats:
                float_buggy_values = [
                    # Predefined extreme values from above
                    HUGE_POS, HUGE_NEG, TINY_POS, TINY_NEG, MACHINE_EPS,
                    # Special float values
                    float('inf'), float('-inf'), float('nan'),
                    0.0, -0.0, 1.0, -1.0, 0.1, -0.1,
                    # Very small and large values
                    1e-10, 1e10, 1e-100, 1e100, 1e-308, 1e308,
                    # Audio/image processing edge cases
                    0.5, 1.5, 2.0, 3.14159, 2.71828,  # Common ratios and constants
                ]
                buggy_candidates.extend([v for v in float_buggy_values if v in values])
            
            if has_bools:
                bool_buggy_values = [True, False]
                buggy_candidates.extend([v for v in bool_buggy_values if v in values])
            
            if has_none:
                buggy_candidates.append(None)

            # Add edge entries from provided values based on type
            str_vals = [v for v in values if isinstance(v, str)]
            if str_vals:
                shortest = min(str_vals, key=len)
                longest = max(str_vals, key=len)
                buggy_candidates.extend([shortest, longest])
            
            num_vals = [v for v in values if isinstance(v, (int, float))]
            if num_vals:
                buggy_candidates.extend([min(num_vals), max(num_vals)])

            # Deduplicate while preserving order
            final_candidates = []
            for candidate in buggy_candidates:
                final_candidates.append(candidate)

            # Use heuristic probability to decide whether to pick from buggy candidates
            if random.random() < heuristic_prob and final_candidates:
                return random.choice(final_candidates)

            return random.choice(values)

        def pick_bool() -> bool:
            # Slightly bias to True only when heuristic triggers; otherwise uniform
            if random.random() < heuristic_prob:
                return random.choice([True, False, True])
            return random.choice([True, False])

        for k, spec in param_space.items():
            try:
                if isinstance(spec, dict) and "type" in spec:
                    t = spec.get("type")
                    if t == "int_range":
                        params[k] = pick_int(spec)
                    elif t == "float_range":
                        params[k] = pick_float(spec)
                    elif t == "categorical":
                        params[k] = pick_categorical(spec)
                    elif t == "bool":
                        params[k] = pick_bool()
                    elif t == "segments":
                        # Pass segments specs directly to generator
                        params[k] = spec
                    else:
                        # Unknown type, use as-is
                        params[k] = spec
                else:
                    params[k] = spec
            except (KeyError, ValueError, TypeError):
                # Handle invalid parameter specs gracefully
                params[k] = f"invalid_param_{k}"
        return params

    def _run_one(self, iteration: int, params: Dict[str, Any], generate_func,
                from_batch_plan: bool, breakpoints: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """Run a single test iteration.
        
        Args:
            iteration: Current iteration number
            params: Parameters for this iteration
            generate_func: Pre-loaded generator function
            from_batch_plan: Whether this iteration is from batch plan
            breakpoints: Optional list of breakpoints
        
        Returns:
            Dict containing the result of this iteration
        """
        workdir = self.config.output_dir
        # Handle None breakpoints
        if breakpoints is None:
            breakpoints = []
        
        # Debugger adds significant overhead (500-1000ms), so we need more time
        exec_timeout = self.timeout_s
        if from_batch_plan and breakpoints and self.debugger_instance:
            # Phase 1 with debugger: use 3x timeout, minimum 3 seconds
            exec_timeout = max(3.0, self.timeout_s * 3)
            
        try:
            # Use timeout wrapper to call generator function
            generator_timeout = getattr(self, 'generator_timeout_sec', 2)
            data, used_params = self._run_generator_with_timeout(
                generate_func, 
                generator_timeout, 
                **params
            )
            
            if not isinstance(data, (bytes, bytearray)):
                error_result = {
                    "type": "error",
                    "iter": iteration,
                    "stage": "generate",
                    "parameters": params,
                    "message": f"Generator must return bytes, got {type(data).__name__}"
                }
                self._log_error_to_file(f"Generation type error: {error_result}", "generator_execution")
                return error_result
        except GeneratorImportError as e:
            error_result = {
                "type": "error",
                "iter": iteration,
                "stage": "generator_import",
                "parameters": params,
                "message": f"Generator import failed: {str(e)}"
            }
            self._log_error_to_file(f"Generator import error: {error_result}", "generator_execution")
            return error_result
        except GeneratorTimeoutError as e:
            error_message = (
                f"Generator function timed out: {str(e)}\n\n"
                "Please avoid using this MCP tool. Just run the fuzzer from the command line:\n"
                f"python3 {Path(__file__).absolute()} "
                f"{self.generator_dir}/gen_{self.round}.py "
                f"{self.plan_dir}/plan_{self.round}.json "
                f"{self.plan_dir}/runtime_config_{self.round}.json\n\n"
            )
            error_result = {
                "type": "error",
                "iter": iteration,
                "stage": "generator_timeout",
                "parameters": params,
                "message": error_message
            }
            self._log_error_to_file(f"Generator timeout error: {error_result}", "generator_execution")
            return error_result
        except Exception as e:
            error_result = {
                "type": "error",
                "iter": iteration,
                "stage": "generate",
                "parameters": params,
                "message": repr(e)
            }
            self._log_error_to_file(f"General exception in _run_one: {error_result}", "generator_execution")
            return error_result

        testcase = workdir / "cur_testcase"
        testcase.write_bytes(data)

        start = time.time()
        timeout, exit_code, stderr = False, 0, ""
        debugger_debug = None
        
        if self.debugger_instance and (from_batch_plan or self.use_debugger) and breakpoints:
            try:
                # Use debugger to run the command - read file content first
                with open(testcase, "rb") as f:
                    file_content = f.read()
                cmd_args, stdin_data = utils.prepare_cmd_and_stdin(
                    self.cmd_template, str(testcase), file_content)
                result = self.debugger_instance.run_sync(
                    cmd=cmd_args,
                    stdin=stdin_data,
                    exec_timeout_sec=int(exec_timeout) if exec_timeout else None,
                    breakpoints=breakpoints  # Pass breakpoints from plan
                )
                
                timeout = result.has_timeout
                exit_code = result.exit_code if result.exit_code is not None else 124
                stderr = result.stderr
                debugger_debug = {
                    "breakpoints": [bp.model_dump() for bp in result.breakpoints],
                    "signal": result.signal,
                    "breakpoint_hits": sum(bp.hit_times for bp in result.breakpoints),
                    "total_breakpoints": len(result.breakpoints)
                }

            except Exception as e:
                error_result = {
                    "type": "error",
                    "iter": iteration,
                    "stage": "debug_run",
                    "parameters": params,
                    "message": repr(e)
                }
                self._log_error_to_file(f"Debug run error: {error_result}", "debug_execution")
                # Fallback to subprocess if debugger fails
                try:
                    with open(testcase, "rb") as f:
                        file_content = f.read()
                    cmd_args, stdin_data = utils.prepare_cmd_and_stdin(
                        self.cmd_template, str(testcase), file_content)
                    proc = subprocess.run(cmd_args,
                                          input=stdin_data,
                                          stdout=subprocess.DEVNULL,
                                          stderr=subprocess.PIPE,
                                          cwd=str(workdir),
                                          timeout=exec_timeout)
                    exit_code = proc.returncode
                    stderr = proc.stderr.decode("utf-8", errors="replace")
                except subprocess.TimeoutExpired:
                    timeout = True
                    exit_code = 124  # Standard timeout exit code
        else:
            # Original subprocess logic
            try:
                # Read file content first with absolute path
                with open(testcase, "rb") as f:
                    file_content = f.read()
                cmd_args, stdin_data = utils.prepare_cmd_and_stdin(
                    self.cmd_template, str(testcase), file_content)
                
                proc = subprocess.run(cmd_args,
                                      input=stdin_data,
                                      stdout=subprocess.DEVNULL,
                                      stderr=subprocess.PIPE,
                                      cwd=str(workdir),
                                      timeout=exec_timeout)
                exit_code = proc.returncode
                stderr = proc.stderr.decode("utf-8", errors="replace")
            except subprocess.TimeoutExpired:
                timeout = True
                exit_code = 124  # Standard timeout exit code

        dur_ms = int((time.time()-start)*1000)
        reached, triggered = 0, 0
        if not timeout and stderr:
            if self.reached_pat.search(stderr): reached = 1
            if self.triggered_pat.search(stderr): triggered = 1

        # Determine current phase based on from_batch_plan
        current_phase = "phase1" if from_batch_plan else "phase2"
        
        # Build testcase filename with status suffixes
        testcase_name = f"round{self.round}_{current_phase}_iter{iteration}"
        if triggered:
            testcase_name += "_triggered"
        elif reached:
            testcase_name += "_reached"
        
        # Save testcase to testcases directory
        testcase_path = self.testcases_dir / testcase_name
        testcase_path.write_bytes(data)
        
        result = {
            "type": "iter_result",
            "iter": iteration,
            "parameters": used_params,
            "reached": reached,
            "triggered": triggered,
            "timeout": timeout,
            "exit_code": exit_code,
            "duration_ms": dur_ms,
            "testcase_file": str(testcase_path)
        }
        
        # Only add debugger_debug if debugger was actually used
        if debugger_debug is not None:
            result["debugger_debug"] = debugger_debug
        
        self.logger.debug(f"Iteration {iteration} result: reached={reached}, triggered={triggered}, timeout={timeout}")

        # Also save to legacy locations for backward compatibility
        if triggered:
            poc_path = self.crashes_dir / f"poc_{self.round}_{iteration}"
            poc_path.write_bytes(data)
            self.logger.info(f"Trigger found! Saved POC to {poc_path}")
            # CyberGym purple agent watches these files for outer-loop validation
            try:
                out_root = Path(self.config.output_dir)
                (out_root / "candidate_poc.bin").write_bytes(data)
                (out_root / "CANDIDATE_READY").write_text(
                    f"poc_{self.round}_{iteration}\n", encoding="utf-8"
                )
            except OSError as e:
                self.logger.warning("Could not write candidate_poc.bin: %s", e)
        return result

    def _setup_fuzz_inputs(self, plan, runtime_config, results):
        """Setup and validate fuzz inputs."""
        # Handle Pydantic models vs dictionaries
        if not isinstance(plan, dict):
            plan_dict = plan.model_dump()
            param_space = plan_dict.get("parameter_space", {})
            batch_plan = plan_dict.get("next_batch_plan", [])
            breakpoints = plan_dict.get("breakpoints", [])
        else:
            plan_dict = plan
            param_space = plan.get("parameter_space", {})
            batch_plan = plan.get("next_batch_plan", [])
            breakpoints = plan.get("breakpoints", [])
        
        # Write plan to file (now that we have plan_dict)
        plan_file = self.plan_dir / f"plan_{self.round}.json"
        with open(plan_file, "w") as f:
            json.dump(plan_dict, f, indent=2)
        self.logger.debug(f"Plan written to {plan_file}")
        results["summary"]["plan_file"] = str(plan_file)
        
        # Convert runtime_config to dict first for serialization
        if not isinstance(runtime_config, dict):
            runtime_config_dict = runtime_config.model_dump()
        else:
            runtime_config_dict = dict(runtime_config)
        
        # Add default values if missing
        if "cmd" not in runtime_config_dict:
            runtime_config_dict["cmd"] = "/bin/true @@"
        if "max_iters" not in runtime_config_dict:
            runtime_config_dict["max_iters"] = 100
        if "exec_timeout_sec" not in runtime_config_dict:
            runtime_config_dict["exec_timeout_sec"] = 3
        if "reached_pattern" not in runtime_config_dict:
            runtime_config_dict["reached_pattern"] = r"REACHED"
        if "triggered_pattern" not in runtime_config_dict:
            runtime_config_dict["triggered_pattern"] = r"TRIGGERED"
        if "generator_timeout_sec" not in runtime_config_dict:
            runtime_config_dict["generator_timeout_sec"] = 2
        if "fuzz_timeout_sec" not in runtime_config_dict:
            runtime_config_dict["fuzz_timeout_sec"] = 30.0
        
        # Write runtime config to file
        runtime_config_file = self.plan_dir / f"runtime_config_{self.round}.json"
        with open(runtime_config_file, "w") as f:
            json.dump(runtime_config_dict, f, indent=2)
        self.logger.debug(f"Runtime config written to {runtime_config_file}")
        results["summary"]["runtime_config_file"] = str(runtime_config_file)

        self._parse_runtime_config(runtime_config_dict)
        max_iters = runtime_config_dict["max_iters"]
        
        if breakpoints:
            is_valid = True
            if not breakpoints[0].get("location"):
                self._log_error_to_file(f"Breakpoints must have location", "config_validation")
                is_valid = False
            if breakpoints[0].get("for_precond_id"):
                self._log_error_to_file(f"Breakpoints must not have for_precond_id", "config_validation")
                is_valid = False
            if not is_valid:
                self._log_error_to_file(f"Invalid breakpoints: {breakpoints}", "config_validation")
        
        return param_space, batch_plan, breakpoints, max_iters

    def _init_results(self):
        """Initialize results structure."""
        return {
            "iterations": [],
            "summary": {
                "total_iterations": 0,
                "reached_count": 0,
                "triggered_count": 0,
                "timeout_count": 0,
                "error_count": 0
            }
        }

    def _setup_generator(self, generator_code, results):
        """Setup generator and return function or error result."""
        generator_file = self.generator_dir / f"gen_{self.round}.py"
        # Pre-inject common imports to avoid runtime errors and improve performance
        enhanced_code = self._inject_common_imports(generator_code)
        with open(generator_file, "w") as f:
            f.write(enhanced_code)
        results["summary"]["generator_file"] = str(generator_file)
        
        try:
            generate_func = self._load_dynamic_generator(self.round)
            self.logger.debug(f"Successfully loaded dynamic generator for round {self.round}")
            return generate_func
        except GeneratorImportError as e:
            self._log_error_to_file(f"Generator loading failed: {str(e)}", "generator_setup")
            error_result = {
                "iterations": [{
                    "type": "error",
                    "iter": 0,
                    "stage": "generator_import",
                    "parameters": {},
                    "message": f"Failed to load generator: {str(e)}"
                }],
                "summary": {
                    "total_iterations": 1,
                    "reached_count": 0,
                    "triggered_count": 0,
                    "timeout_count": 0,
                    "error_count": 1
                }
            }
            return FuzzResult(
                iterations=[IterationResult.model_validate(it) for it in error_result["iterations"]],
                summary=FuzzSummary.model_validate(error_result["summary"])
            )
        except Exception as e:
            self._log_error_to_file(f"Unexpected error loading generator: {str(e)}", "generator_setup")
            error_result = {
                "iterations": [{
                    "type": "error",
                    "iter": 0,
                    "stage": "generator_load_unexpected",
                    "parameters": {},
                    "message": f"Unexpected error loading generator: {str(e)}"
                }],
                "summary": {
                    "total_iterations": 1,
                    "reached_count": 0,
                    "triggered_count": 0,
                    "timeout_count": 0,
                    "error_count": 1
                }
            }
            return FuzzResult(
                iterations=[IterationResult.model_validate(it) for it in error_result["iterations"]],
                summary=FuzzSummary.model_validate(error_result["summary"])
            )

    def _update_summary(self, results, result):
        """Update summary statistics."""
        if result.get("type") == "error":
            results["summary"]["error_count"] += 1
        else:
            if result.get("reached"): results["summary"]["reached_count"] += 1
            if result.get("triggered"): results["summary"]["triggered_count"] += 1
            if result.get("timeout"): results["summary"]["timeout_count"] += 1

    def _sync_summary_with_iterations(self, results):
        """Sync summary statistics with actual stored iterations to prevent validation errors."""
        iterations = results.get("iterations", [])
        
        # Recalculate summary based on actual stored iterations
        reached_count = sum(1 for it in iterations if it.get("reached") == 1)
        triggered_count = sum(1 for it in iterations if it.get("triggered") == 1)
        timeout_count = sum(1 for it in iterations if it.get("timeout") is True)
        error_count = sum(1 for it in iterations if it.get("type") == "error")
        
        # Update summary with recalculated values
        results["summary"]["reached_count"] = reached_count
        results["summary"]["triggered_count"] = triggered_count
        results["summary"]["timeout_count"] = timeout_count
        results["summary"]["error_count"] = error_count

    def _save_and_return_fuzz_result(self, results):
        """Save results to file and return FuzzResult object."""
        # Sync summary with actual iterations to prevent validation errors
        self._sync_summary_with_iterations(results)
        
        with open(self.fuzz_results_dir / f"results_{self.round}.json", "w") as f:
            json.dump(results, f, indent=2)
        
        return FuzzResult(
            iterations=[IterationResult.model_validate(it) for it in results["iterations"]],
            summary=FuzzSummary.model_validate(results["summary"])
        )

    def _check_trigger_found(self, results, iteration, plan):
        """Check if trigger found and return results if so."""
        # Check if POC file exists AND if we actually have triggered iterations
        poc_exists = (self.crashes_dir / f"poc_{iteration}").exists()
        has_triggered = results["summary"]["triggered_count"] > 0
        
        if not (poc_exists and has_triggered):
            return None
        
        results["summary"]["total_iterations"] = iteration
        self.logger.info(f"Trigger found at iteration {iteration}!")
        
        return self._save_and_return_fuzz_result(results)

    def _execute_batch_phase(self, results, batch_plan, generate_func, breakpoints, max_iters, plan, fuzz_start_time, fuzz_timeout_sec):
        """Execute Phase 1: batch plan execution."""
        batch_plan = batch_plan or []
        total_batch = min(max_iters, len(batch_plan))
        batch_plan_len = len(batch_plan) if batch_plan else 0
        self.logger.debug(f"Has batch plan: {bool(batch_plan)} with {batch_plan_len} items")
        
        for iteration in range(1, total_batch + 1):
            # Check timeout before each iteration
            elapsed_time = time.time() - fuzz_start_time
            if elapsed_time >= fuzz_timeout_sec:
                self.logger.info(f"Fuzzing timeout reached ({elapsed_time:.2f}s >= {fuzz_timeout_sec}s) during Phase 1 at iteration {iteration}")
                results["summary"]["total_iterations"] = iteration - 1
                results["summary"]["timeout_info"] = {
                    "timed_out": True,
                    "elapsed_time_sec": elapsed_time,
                    "timeout_limit_sec": fuzz_timeout_sec,
                    "phase": "Phase 1 (Batch Plan)",
                    "completed_iterations": iteration - 1,
                    "remaining_batch_iterations": total_batch - (iteration - 1),
                    "remaining_sampling_iterations": max(0, max_iters - total_batch)
                }
                return self._save_and_return_fuzz_result(results)
            
            params = batch_plan[iteration - 1]
            try:
                result = self._run_one(iteration, params, generate_func, from_batch_plan=True, breakpoints=breakpoints)
            except Exception as e:
                result = {
                    "type": "error",
                    "iter": iteration,
                    "stage": "run_one_exception",
                    "parameters": params,
                    "message": f"Unexpected error in _run_one: {repr(e)}"
                }
                self._log_error_to_file(f"Unexpected error in _run_one: {result}", "fuzzing_execution")
            
            results["iterations"].append(result)
            self._update_summary(results, result)
            if result["type"] == "error":
                results["summary"]["total_iterations"] = iteration
                return self._save_and_return_fuzz_result(results)
            
            trigger_result = self._check_trigger_found(results, iteration, plan)
            if trigger_result is not None:
                return trigger_result
        
        return total_batch

    def _execute_sampling_phase(self, results, param_space, generate_func, breakpoints, max_iters, start_iteration, plan, fuzz_start_time, fuzz_timeout_sec):
        """Execute Phase 2: parameter space sampling."""
        has_selected_params = set()
        actual_iteration_count = 0  # Track actual executed iterations
        
        for iteration in range(start_iteration + 1, max_iters + 1):
            # Check timeout before each iteration
            elapsed_time = time.time() - fuzz_start_time
            if elapsed_time >= fuzz_timeout_sec:
                self.logger.info(f"Fuzzing timeout reached ({elapsed_time:.2f}s >= {fuzz_timeout_sec}s) during Phase 2 at iteration {iteration}")
                results["summary"]["total_iterations"] = start_iteration + actual_iteration_count
                results["summary"]["timeout_info"] = {
                    "timed_out": True,
                    "elapsed_time_sec": elapsed_time,
                    "timeout_limit_sec": fuzz_timeout_sec,
                    "phase": "Phase 2 (Parameter Sampling)",
                    "completed_iterations": start_iteration + actual_iteration_count,
                    "remaining_batch_iterations": 0,  # Batch phase already completed
                    "remaining_sampling_iterations": max_iters - iteration
                }
                return self._save_and_return_fuzz_result(results)
            
            params = self._sample_from_space(param_space or {}, seed=iteration)
            
            # Serialize params to handle nested structures (dict, list, etc.)
            try:
                params_key = json.dumps(params, sort_keys=True, default=str)
            except (TypeError, ValueError):
                # Fallback if serialization fails
                params_key = str(sorted(params.items()))
            
            if params_key in has_selected_params:
                self.logger.debug(f"Skipping duplicate params at iteration {iteration}")
                continue
            has_selected_params.add(params_key)
            actual_iteration_count += 1  # Increment only when actually executing
            
            try:
                result = self._run_one(iteration, params, generate_func, from_batch_plan=False, breakpoints=breakpoints)
            except Exception as e:
                result = {
                    "type": "error",
                    "iter": iteration,
                    "stage": "run_one_exception",
                    "parameters": params,
                    "message": f"Unexpected error in _run_one: {repr(e)}"
                }
                self._log_error_to_file(f"Unexpected error in _run_one: {result}", "fuzzing_execution")
            
            # Store Phase 2 iteration details probabilistically
            # Always store: errors, triggers, timeouts for validation consistency
            # Probabilistically store: reached (for debugging) up to limit
            should_store = (
                result.get("triggered") or 
                result.get("type") == "error" or
                result.get("timeout") or
                (len(results["iterations"]) < 20 and result.get("reached"))
            )
            if should_store:
                results["iterations"].append(result)
                self._update_summary(results, result)

            if result["type"] == "error":
                results["summary"]["total_iterations"] = start_iteration + actual_iteration_count
                return self._save_and_return_fuzz_result(results)
            
            trigger_result = self._check_trigger_found(results, iteration, plan)
            if trigger_result is not None:
                return trigger_result
        
        return start_iteration + actual_iteration_count

    def _finalize_results(self, results, final_iteration, plan):
        """Finalize and return results."""
        results["summary"]["total_iterations"] = final_iteration
        self.logger.debug(f"Fuzzing completed. {final_iteration} iterations, triggered_count={results['summary']['triggered_count']}")
        
        return self._save_and_return_fuzz_result(results)

    def fuzz(self, plan, runtime_config, generator_code):
        """Main fuzzing API.
        
        Args:
            plan: Dictionary containing parameter_space and next_batch_plan
            runtime_config: Dictionary containing runtime configuration
            generator_code: Code for generating input data
        
        Returns:
            Dictionary containing all fuzzing results following the output schema
        """
        self.logger.debug("Starting fuzzing session")
        self.round += 1
        self.logger.info(f"Starting fuzzing round {self.round}")
        
        try:
            results = self._init_results()
            # Setup and validation (this parses runtime_config and sets self.fuzz_timeout_sec)
            param_space, batch_plan, breakpoints, max_iters = self._setup_fuzz_inputs(plan, runtime_config, results)
            
            # Start timeout tracking using value from runtime_config
            fuzz_start_time = time.time()
            fuzz_timeout_sec = self.fuzz_timeout_sec
            
            # Load generator
            generate_func = self._setup_generator(generator_code, results)
            if isinstance(generate_func, FuzzResult):  # Error result
                return generate_func
            
            # Execute fuzzing phases with timeout tracking
            iteration = self._execute_batch_phase(results, batch_plan, generate_func, breakpoints, max_iters, plan, fuzz_start_time, fuzz_timeout_sec)
            if isinstance(iteration, FuzzResult):  # Early return with results
                return iteration
            
            final_iteration = self._execute_sampling_phase(results, param_space, generate_func, breakpoints, max_iters, iteration, plan, fuzz_start_time, fuzz_timeout_sec)
            if isinstance(final_iteration, FuzzResult):  # Early return with results
                return final_iteration
            
            # Finalize results
            return self._finalize_results(results, final_iteration, plan)
            
        finally:
            if self._debugger_instance:
                self._debugger_instance.close()
            self._debugger_instance = None


def _format_debugger_info(debug_info: Dict[str, Any]) -> str:
    """Format debugger information for display."""
    if not debug_info:
        return ""
    
    result_text = ""
    bp_hits = debug_info.get("breakpoint_hits", 0)
    total_bps = debug_info.get("total_breakpoints", 0)
    sig = debug_info.get("signal")
    
    result_text += f"  • 🔍 Debugger: {bp_hits} breakpoint hits across {total_bps} breakpoints\n"
    if sig:
        result_text += f"  • Signal: {sig}\n"
    
    # Show breakpoint details
    breakpoints = debug_info.get("breakpoints", [])
    for bp in breakpoints:
        if not bp or bp.get("hit_times", 0) <= 0:
            continue
            
        result_text += f"    - {bp.get('file_path', 'unknown')}:{bp.get('line', 0)} hit {bp.get('hit_times', 0)} times\n"
        
        # Show inline expressions if available
        hits_info = bp.get("hits_info", [])
        for hit in hits_info[:2]:  # Show first 2 hits
            if not hit:
                continue
                
            inline_exprs = hit.get("inline_expr", [])
            if not inline_exprs:
                continue
                
            result_text += f"      Expressions: "
            expr_strs = []
            for expr in inline_exprs[:3]:
                if expr and isinstance(expr, dict) and 'name' in expr and 'value' in expr:
                    expr_strs.append(f"{expr['name']}={expr['value']}")
            
            if expr_strs:
                result_text += ", ".join(expr_strs) + "\n"
    
    return result_text


def _format_iteration_result(iter_result: Dict[str, Any]) -> str:
    """Format a single iteration result for display."""
    if iter_result is None:
        return ""
    
    result_text = ""
    iter_num = iter_result.get("iter", 0)
    iter_type = iter_result.get("type", "unknown")
    
    if iter_type == "error":
        stage = iter_result.get("stage", "unknown")
        message = iter_result.get("message", "Unknown error")
        params = iter_result.get("parameters", {})
        result_text += f"\n**Iteration {iter_num}** ❌ ERROR\n"
        result_text += f"  • Stage: {stage}\n"
        result_text += f"  • Message: {message}\n"
        result_text += f"  • Parameters: {json.dumps(params, indent=2)}\n"
    else:
        # Success iteration
        reached = iter_result.get("reached", 0)
        triggered = iter_result.get("triggered", 0)
        timeout = iter_result.get("timeout", False)
        exit_code = iter_result.get("exit_code")
        duration = iter_result.get("duration_ms", 0)
        params = iter_result.get("parameters", {})
        testcase_file = iter_result.get("testcase_file")
        
        # Status indicators
        reached_icon = "✅" if reached else "❌"
        triggered_icon = "🎯" if triggered else "❌"
        timeout_icon = "⏰" if timeout else "✅"
        
        result_text += f"\n**Iteration {iter_num}** "
        if triggered:
            result_text += "🎯 TRIGGERED\n"
        elif reached:
            result_text += "✅ REACHED\n"
        else:
            result_text += "❌ MISSED\n"
        
        result_text += f"  • Reached: {reached_icon} ({reached})\n"
        result_text += f"  • Triggered: {triggered_icon} ({triggered})\n"
        result_text += f"  • Timeout: {timeout_icon} ({timeout})\n"
        result_text += f"  • Exit code: {exit_code}\n"
        result_text += f"  • Duration: {duration}ms\n"
        if testcase_file:
            result_text += f"  • Saved Testcase: {testcase_file}\n"
        result_text += f"  • Parameters: {json.dumps(params, indent=2)}\n"
        
        # Show debugger info if available
        debug_info = iter_result.get("debugger_debug")
        if debug_info:
            result_text += _format_debugger_info(debug_info)
    
    return result_text


def format_fuzzing_results(results_dict: Dict[str, Any], plan: Dict[str, Any]) -> str:
    """Format fuzzing results using the same logic as MCP server."""
    summary = results_dict.get("summary", {})
    iterations = results_dict.get("iterations", [])
    
    result_text = "🧪 **Property-Based Fuzzing Results**\n\n"
    
    # Executive Summary
    result_text += "📊 **Executive Summary:**\n"
    result_text += f"• Total iterations executed: {summary.get('total_iterations', 0)}\n"
    result_text += f"• Detailed results available: {len(iterations)}\n"
    result_text += f"• Target reached: {summary.get('reached_count', 0)} times ({summary.get('reached_count', 0)/max(summary.get('total_iterations', 1), 1)*100:.1f}%)\n"
    result_text += f"• Bug triggered: {summary.get('triggered_count', 0)} times ({summary.get('triggered_count', 0)/max(summary.get('total_iterations', 1), 1)*100:.1f}%)\n"
    result_text += f"• Timeouts: {summary.get('timeout_count', 0)} ({summary.get('timeout_count', 0)/max(summary.get('total_iterations', 1), 1)*100:.1f}%)\n"
    result_text += f"• Errors: {summary.get('error_count', 0)} ({summary.get('error_count', 0)/max(summary.get('total_iterations', 1), 1)*100:.1f}%)\n"
    
    # Fuzzing input files. saved generator, plan, runtime_config
    if summary.get("generator_file"):
        result_text += f"• Generator file: {summary.get('generator_file')}\n"
    if summary.get("plan_file"):
        result_text += f"• Plan file: {summary.get('plan_file')}\n"
    if summary.get("runtime_config_file"):
        result_text += f"• Runtime config file: {summary.get('runtime_config_file')}\n"
    
    # Overall Status
    if summary.get("triggered_count", 0) > 0:
        result_text += "\n🎯 **STATUS: SUCCESS** - Bug triggered! PoC saved to crashes/ directory.\n"
    elif summary.get("reached_count", 0) > 0:
        result_text += "\n🟡 **STATUS: PARTIAL** - Target reached but bug not triggered.\n"
    else:
        result_text += "\n🔴 **STATUS: NO SUCCESS** - Target not reached.\n"
    
    # Timeout Information
    timeout_info = summary.get("timeout_info")
    if timeout_info and timeout_info.get("timed_out"):
        result_text += f"\n⏰ **TIMEOUT OCCURRED** - Fuzzing stopped after {timeout_info.get('elapsed_time_sec', 0):.2f}s (limit: {timeout_info.get('timeout_limit_sec', 30)}s)\n"
        result_text += f"• **Phase when timeout occurred**: {timeout_info.get('phase', 'Unknown')}\n"
        result_text += f"• **Completed iterations**: {timeout_info.get('completed_iterations', 0)}\n"
        if timeout_info.get('remaining_batch_iterations', 0) > 0:
            result_text += f"• **Remaining batch plan iterations**: {timeout_info.get('remaining_batch_iterations', 0)}\n"
        if timeout_info.get('remaining_sampling_iterations', 0) > 0:
            result_text += f"• **Remaining sampling iterations**: {timeout_info.get('remaining_sampling_iterations', 0)}\n"
    
    # Phase Analysis
    batch_plan_size = len(plan.get("next_batch_plan", []))
    if batch_plan_size > 0:
        result_text += "\n📋 **Phase Analysis:**\n"
        result_text += f"• Phase 1 (Targeted): {min(batch_plan_size, summary.get('total_iterations', 0))} iterations from batch plan\n"
        
        # Warn about debugger overhead in Phase 1
        if plan.get("breakpoints"):
            result_text += f"  ⚠️ **Debugger Mode Active**: Phase 1 uses debugger for breakpoint evaluation\n"
            result_text += f"  💡 **Tip**: Timeout automatically increased 3x (min 3s) for debugger mode\n"
        
        if summary.get('total_iterations', 0) > batch_plan_size:
            result_text += f"• Phase 2 (Exploration): {summary.get('total_iterations', 0) - batch_plan_size} iterations from parameter space\n"
    
    # Detailed Iteration Results
    if iterations:
        result_text += "\n📝 **Detailed Iteration Results:**\n"
        
        # Separate Phase 1 and Phase 2 results
        phase1_results = [it for it in iterations if it is not None and it.get("iter", 0) <= batch_plan_size]
        phase2_results = [it for it in iterations if it is not None and it.get("iter", 0) > batch_plan_size]
        
        # Show Phase 1 results
        if phase1_results:
            result_text += f"\n🎯 **Phase 1 Results** (Batch Plan - {len(phase1_results)} shown):\n"
            for iter_result in phase1_results:
                result_text += _format_iteration_result(iter_result)
        
        # Show Phase 2 results with special focus on reached cases
        if phase2_results:
            phase2_reached = [it for it in phase2_results if it.get("reached", 0)]
            result_text += f"\n🔄 **Phase 2 Results** (Parameter Sampling - {len(phase2_results)} shown):\n"
            
            # Show reached cases first with parameters
            if phase2_reached:
                result_text += f"\n✅ **Phase 2 Reached Cases** ({len(phase2_reached)} cases):\n"
                for iter_result in phase2_reached:
                    iter_num = iter_result.get("iter", 0)
                    params = iter_result.get("parameters", {})
                    testcase_file = iter_result.get("testcase_file")
                    result_text += f"\n**Iteration {iter_num}** ✅ REACHED\n"
                    if testcase_file:
                        result_text += f"  • **Saved Testcase**: {testcase_file}\n"
                    result_text += f"  • **Used Parameters**: {json.dumps(params, indent=2)}\n"
        
        else:
            result_text += "\n🔄 **Phase 2 Results**: No Phase 2 results stored (only errors/triggers/timeouts are kept)\n"
    
    # Error Pattern Analysis
    error_iterations = [it for it in iterations if it is not None and it.get("type") == "error"]
    if error_iterations:
        result_text += "\n⚠️ **Error Pattern Analysis:**\n"
        error_stages = {}
        for err_iter in error_iterations:
            stage = err_iter.get("stage", "unknown")
            message = err_iter.get("message", "Unknown error")
            if stage not in error_stages:
                error_stages[stage] = []
            error_stages[stage].append(message)
        
        for stage, messages in error_stages.items():
            result_text += f"• **{stage}**: {len(messages)} error(s)\n"
            # Show unique error messages
            unique_messages = list(set(messages))
            for msg in unique_messages[:3]:  # Show first 3 unique messages
                count = messages.count(msg)
                result_text += f"  - {msg} (×{count})\n"
            if len(unique_messages) > 3:
                result_text += f"  - ... and {len(unique_messages) - 3} more unique errors\n"
    
    # Strategic Recommendations
    result_text += "\n💡 **Strategic Recommendations:**\n"
    
    # Error rate analysis
    error_rate = summary.get("error_count", 0) / max(summary.get("total_iterations", 1), 1)
    if error_rate > 0.5:
        result_text += "• **HIGH ERROR RATE**: Check generator code and command configuration.\n"
    elif error_rate > 0.2:
        result_text += "• **MODERATE ERROR RATE**: Review generator logic and parameter handling.\n"
    
    # Timeout analysis
    timeout_rate = summary.get("timeout_count", 0) / max(summary.get("total_iterations", 1), 1)
    if timeout_rate > 0.3:
        result_text += "• **HIGH TIMEOUT RATE**: Consider increasing timeout or optimizing generator.\n"
    
    # Phase 1+2 Overall Assessment
    if summary.get("triggered_count", 0) > 0:
        result_text += "• **SUCCESS**: Bug triggered! Please update the metrics, transition to SUCCESS phase and terminate.\n"
    elif summary.get("reached_count", 0) > 0:
        result_text += "• **PARTIAL**: Target reached but not triggered. Please update the metrics, transition to REFLECT phase and analyze the reason.\n"
    else:
        result_text += "• **NO PROGRESS**: Target not reached. Please update the metrics, transition to REFLECT phase and analyze the reason.\n"
                    
    return result_text


def main():
    """Main function that reads configuration from plan.json file and generator from argv[1]."""
    if len(sys.argv) < 4:
        print("Error: Runtime config file is required as 3rd argument", file=sys.stderr)
        print("Usage: python property_based_fuzzer.py <generator_file_path> <plan_file_path> <runtime_config_file_path>", file=sys.stderr)
        sys.exit(1)
    
    generator_file_path = sys.argv[1]
    
    # Read generator code from specified file
    try:
        with open(generator_file_path, 'r') as f:
            generator_code = f.read()
    except FileNotFoundError:
        print(f"Error: Generator file '{generator_file_path}' not found", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error reading generator file '{generator_file_path}': {e}", file=sys.stderr)
        sys.exit(1)
    
    config = Config()
    
    # Load plan from single file (unified format or separate files)
    plan_file = Path(sys.argv[2] if len(sys.argv) > 2 else "plan.json")
    plan_data = PropertyBasedFuzzer._load_json_if(plan_file, {})
    
    # Extract plan (never contains runtime config according to today's changes)
    plan = {
        "parameter_space": plan_data.get("parameter_space", {}),
        "next_batch_plan": plan_data.get("next_batch_plan", []),
        "breakpoints": plan_data.get("breakpoints", [])
    }
    
    # Load runtime config from the 3rd argument
    runtime_config_file = Path(sys.argv[3])
    runtime_config_data = PropertyBasedFuzzer._load_json_if(runtime_config_file, {})
    runtime_config = {
        "cmd": runtime_config_data["cmd"],
        "max_iters": runtime_config_data["max_iters"],
        "exec_timeout_sec": runtime_config_data["exec_timeout_sec"],
        "reached_pattern": runtime_config_data["reached_pattern"],
        "triggered_pattern": runtime_config_data["triggered_pattern"],
        "generator_timeout_sec": runtime_config_data.get("generator_timeout_sec", 2),
        "fuzz_timeout_sec": runtime_config_data.get("fuzz_timeout_sec", 30.0)
    }
    # Create fuzzer instance and run
    fuzzer = PropertyBasedFuzzer(config)
    results = fuzzer.fuzz(plan, runtime_config, generator_code)
    
    # Convert Pydantic model to dict if needed for compatibility
    if not isinstance(results, dict):
        results = results.model_dump()
    
    # Format and display results using the same logic as MCP server
    formatted_output = format_fuzzing_results(results, plan)
    print(formatted_output)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
