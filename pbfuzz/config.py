import collections
import json
import os
import logging
from pathlib import Path

MAX_INT = float(0x7fffffff)
DEFAULT_LLDB_PATH = "/usr/bin/lldb-20"
DEFAULT_ENABLE_DEBUGGER_FOR_ALL = False

class Config:
    __slots__ = ['__dict__',
                 '__weakref__',
                 'logging_level',
                 "output_dir",
                 'initial_corpus_dir',
                 "cmd",
                 'max_distance',
                 'initial_policy',
                 'initial_distance',
                 'static_result_folder',
                 'source_code_dir',
                 'llm_model',
                 'max_calling_context_depth',
                 'debug_enabled',
                 'enable_static_precondition_inference',
                 # Fuzzer configuration options
                 'reached_pattern',
                 'triggered_pattern',
                 'max_iters',
                 'exec_timeout_sec',
                 'disable_mcp',
                 # Debugger related attributes
                 'lldb_path',
                 'debugger_env',
                 'enable_debugger_for_all',
    ]

    def __init__(self):
        self.logger = logging.getLogger(self.__class__.__qualname__)
        self._load_default()

    def load(self, path):
        if not path:
            return
        if not os.path.isfile(path):
            raise ValueError(f"{path} does not exist")
        with open(path, 'r') as file:
            new_config = json.load(file)
        for key, value in new_config.items():
            # Convert string paths back to Path objects for specific fields
            if key in ('output_dir', 'static_result_folder', 'source_code_dir') and isinstance(value, str):
                setattr(self, key, Path(value))
            elif key == 'source_code_folder' and isinstance(value, str):
                # Map source_code_folder to source_code_dir for consistency
                setattr(self, 'source_code_dir', Path(value))
            elif key == 'target_loc' and isinstance(value, list):
                setattr(self, key, set(value))  # Convert list back to set
            else:
                setattr(self, key, value)

    def save(self, path):
        with open(path, 'w') as file:
            # Convert Path objects to strings for JSON serialization
            # Handle various non-serializable objects
            serializable_dict = {}
            for key, value in self.__dict__.items():
                if key == 'logger':  # Skip logger
                    continue
                elif isinstance(value, Path):
                    serializable_dict[key] = str(value)
                elif isinstance(value, set):
                    serializable_dict[key] = list(value)  # Convert set to list
                elif isinstance(value, (str, int, float, bool, type(None))):
                    serializable_dict[key] = value
                elif isinstance(value, (list, dict)):
                    serializable_dict[key] = value
                elif hasattr(value, '__dict__'):
                    # Skip complex objects that might not be JSON serializable
                    continue
                else:
                    # Try to serialize, skip if it fails
                    try:
                        json.dumps(value)
                        serializable_dict[key] = value
                    except (TypeError, ValueError):
                        continue
            json.dump(serializable_dict, file, indent=2)

    def load_put_args(self, args):
        if hasattr(args, 'debug_enabled') and args.debug_enabled:
            self.logging_level = logging.DEBUG
        if hasattr(args, 'cmd') and args.cmd:
            self.cmd = args.cmd
        if hasattr(args, 'static_result_folder') and args.static_result_folder:
            self.static_result_folder = Path(args.static_result_folder)
        if hasattr(args, 'source_code_folder') and args.source_code_folder:
            self.source_code_dir = Path(args.source_code_folder)
        if hasattr(args, 'initial_corpus_dir') and args.initial_corpus_dir:
            self.initial_corpus_dir = Path(args.initial_corpus_dir)
        if getattr(args, "output_dir", None) is not None:
            self.output_dir = Path(args.output_dir)
        if getattr(args, "llm_model", None):
            self.llm_model = args.llm_model
        if hasattr(args, 'debug_enabled'):
            self.debug_enabled = args.debug_enabled
        # Handle fuzzer configuration options (do not overwrite JSON from -config with CLI None)
        if getattr(args, "reached_pattern", None):
            self.reached_pattern = args.reached_pattern
        if getattr(args, "triggered_pattern", None):
            self.triggered_pattern = args.triggered_pattern
        if getattr(args, "max_iters", None) is not None:
            self.max_iters = args.max_iters
        if getattr(args, "exec_timeout_sec", None) is not None:
            self.exec_timeout_sec = args.exec_timeout_sec
        if hasattr(args, 'disable_mcp'):
            self.disable_mcp = args.disable_mcp
        # Apply debug settings
        if self.debug_enabled:
            logging.getLogger().setLevel(logging.DEBUG)
            self.logger.debug("Debug mode enabled")

    def _load_default(self):
        # configurations need to be set explicitly by config file or cmd arguments
        self.max_distance = MAX_INT
        self.max_calling_context_depth = 3
        # Debugger configurations
        self.lldb_path = DEFAULT_LLDB_PATH
        # Copy system environment and add extra path
        self.debugger_env = os.environ.copy()
        self.debugger_env['PATH'] = '/usr/lib/llvm-20/bin:' + self.debugger_env.get('PATH', '')
        self.enable_debugger_for_all = DEFAULT_ENABLE_DEBUGGER_FOR_ALL
        self.logging_level = logging.INFO
        self.output_dir = Path('/magma_shared/findings')
        self.initial_corpus_dir = Path('/tmp/empty_corpus')
        self.cmd = ''
        self.static_result_folder = Path('.')
        self.source_code_dir = Path('.')
        self.llm_model = ''
        self.initial_policy = {}
        self.initial_distance = collections.defaultdict(lambda: self.max_distance)
        self.target_loc = set()
        self.debug_enabled = False
        # Fuzzer configuration defaults
        self.reached_pattern = ''
        self.triggered_pattern = ''
        self.max_iters = 1000
        self.exec_timeout_sec = 2
        # Precondition inference defaults
        self.enable_static_precondition_inference = True
        # MCP configuration default
        self.disable_mcp = False
        # Standalone reproduction / optional task metadata
        self.cve_id = ""
        self.task_id = ""
        self.build_cmd = ""
        self.binary_path = ""
        self.run_cmd_template = ""
        self.build_cwd = ""
        self.cybergym_cwd = ""
        self.patch_available = True
