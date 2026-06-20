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
                 'agent_timeout_sec',
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
        if hasattr(args, 'output_dir'):
            self.output_dir = Path(args.output_dir)
        if hasattr(args, 'llm_model'):
            self.llm_model = args.llm_model
        if hasattr(args, 'debug_enabled'):
            self.debug_enabled = args.debug_enabled
        # Handle fuzzer configuration options
        if hasattr(args, 'reached_pattern') and args.reached_pattern:
            self.reached_pattern = args.reached_pattern
        if hasattr(args, 'triggered_pattern') and args.triggered_pattern:
            self.triggered_pattern = args.triggered_pattern
        if hasattr(args, 'max_iters') and args.max_iters is not None:
            self.max_iters = args.max_iters
        if hasattr(args, 'exec_timeout_sec') and args.exec_timeout_sec is not None:
            self.exec_timeout_sec = args.exec_timeout_sec
        if hasattr(args, 'agent_timeout_sec') and args.agent_timeout_sec is not None:
            self.agent_timeout_sec = args.agent_timeout_sec
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
        self.exec_timeout_sec = 3
        self.agent_timeout_sec = 3600
        # Precondition inference defaults
        self.enable_static_precondition_inference = True
        # MCP configuration default
        self.disable_mcp = False
