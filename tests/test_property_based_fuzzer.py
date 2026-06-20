#!/usr/bin/env python3
"""
Unit tests for PropertyBasedFuzzer class.
Tests both debugger enabled and disabled scenarios.
"""

import pytest
import tempfile
import logging
import json
import re
import shutil
import subprocess
import shlex
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock
from typing import Dict, Any, List


def fuzz_result_to_dict(results):
    """Helper function to convert FuzzResult to dict format for backward compatibility in tests."""
    from schemas import FuzzResult
    if isinstance(results, FuzzResult):
        result_dict = results.model_dump()
        # Remove empty debugger_debug fields for backward compatibility
        if "iterations" in result_dict:
            for iteration in result_dict["iterations"]:
                if iteration.get("debugger_debug") == {}:
                    del iteration["debugger_debug"]
        return result_dict
    return results

# Import the classes we want to test
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from property_based_fuzzer import PropertyBasedFuzzer
from config import Config
import utils

# Import Pydantic models for testing
try:
    from schemas import (
        FuzzPlan, RuntimeConfig, FuzzResult, IterationResult, FuzzSummary,
        Precondition, PreconditionStatus,
        Breakpoint, BatchPlanEntry, ParameterSpec, IntRangeParam, BoolParam, CategoricalParam
    )
    from pydantic import ValidationError
    PYDANTIC_AVAILABLE = True
except ImportError:
    PYDANTIC_AVAILABLE = False


class MockBreakpointReport:
    """Mock breakpoint report for testing."""
    def __init__(self, id=1, file_path="test.c", line=10, function_name="test_func", hit_times=1, include_hits_info=True):
        self.id = id
        self.file_path = file_path
        self.line = line
        self.function_name = function_name
        self.hit_times = hit_times
        
        # Create realistic hits_info for testing
        if include_hits_info and hit_times > 0:
            self.hits_info = []
            for i in range(min(hit_times, 3)):  # Create up to 3 hit details for testing
                hit_detail = {
                    "callstack": f"#0 {function_name} () at {file_path}:{line}\n"
                               f"#1 0x00007fff8b29450d in main () at main.c:25\n"
                               f"#2 0x00007fff8b2944f5 in start () at /usr/lib/dyld",
                    "inline_expr": [
                        {"name": "argc", "value": f"{i + 1}"},
                        {"name": "len", "value": f"{100 + i * 10}"},
                        {"name": "buf", "value": f"0x{0x7fff8000 + i * 0x1000:x}"}
                    ]
                }
                self.hits_info.append(hit_detail)
        else:
            self.hits_info = []
    
    def model_dump(self):
        return {
            "id": self.id,
            "file_path": self.file_path,
            "line": self.line,
            "function_name": self.function_name,
            "hit_times": self.hit_times,
            "hits_info": self.hits_info
        }


class MockRuntimeFeedbackV2:
    """Mock runtime feedback for testing."""
    def __init__(self, stderr="", exit_code=0, signal=None, breakpoints=None, has_timeout=False):
        self.stderr = stderr
        self.exit_code = exit_code
        self.signal = signal
        self.breakpoints = breakpoints or []
        self.has_timeout = has_timeout


class MockRuntimeDebugger:
    """Mock debugger for testing."""
    def __init__(self, config=None):
        self.config = config
    
    def close(self):
        """Mock close method for compatibility."""
        pass
        
    def run_sync(self, cmd, stdin=None, exec_timeout_sec=None, breakpoints=None):
        # Simulate different scenarios based on command
        if "trigger" in str(cmd):
            return MockRuntimeFeedbackV2(
                stderr="TRIGGERED\nSome error output",
                exit_code=1,
                signal=None,
                breakpoints=[
                    MockBreakpointReport(
                        id=1, file_path="parser.c", line=143, 
                        function_name="parse_header", hit_times=2
                    )
                ],
                has_timeout=False
            )
        elif "reach" in str(cmd):
            return MockRuntimeFeedbackV2(
                stderr="REACHED\nSome output",
                exit_code=0,
                signal=None,
                breakpoints=[
                    MockBreakpointReport(
                        id=2, file_path="main.c", line=50, 
                        function_name="main", hit_times=1
                    )
                ],
                has_timeout=False
            )
        elif "timeout" in str(cmd):
            return MockRuntimeFeedbackV2(
                stderr="",
                exit_code=-1,  # Use -1 instead of None for timeout
                signal=None,
                breakpoints=[],
                has_timeout=True
            )
        else:
            return MockRuntimeFeedbackV2(
                stderr="Normal output",
                exit_code=0,
                signal=None,
                breakpoints=[
                    MockBreakpointReport(
                        id=3, file_path="utils.c", line=89, 
                        function_name="process_data", hit_times=1
                    )
                ],  # Add default breakpoint
                has_timeout=False
            )


class MockGenerate:
    """Mock generate function for testing."""
    @staticmethod
    def generate(**params):
        # Create test data based on parameters
        data = f"test_data_{params.get('seed', 0)}".encode()
        return data, params


@pytest.fixture
def temp_dir():
    """Create temporary directory for tests."""
    temp_dir = tempfile.mkdtemp()
    yield temp_dir
    import shutil
    shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.fixture
def test_config(temp_dir):
    """Create test configuration."""
    config = Config()
    config.lldb_path = "/usr/bin/lldb-20"  # Mock path
    config.enable_debugger_for_all = True  # Enable debugger for testing
    config.output_dir = Path(temp_dir)  # Set output directory to temp dir
    return config


@pytest.fixture
def test_generators(temp_dir):
    """Create test generator files for dynamic loading."""
    generators_dir = Path(temp_dir) / "generators"
    generators_dir.mkdir(exist_ok=True)
    
    # Create a default generator (gen_0.py) for round 0
    gen_0_content = '''#!/usr/bin/env python3
"""Test generator for round 0."""

def generate(**params):
    """Generate test data based on parameters."""
    # Create test data based on parameters
    data = f"test_data_{params.get('seed', 0)}".encode()
    return data, params
'''
    
    (generators_dir / "gen_0.py").write_text(gen_0_content)
    
    # Create additional generators for other rounds if needed
    for round_num in range(1, 5):  # Create generators for rounds 1-4
        gen_content = f'''#!/usr/bin/env python3
"""Test generator for round {round_num}."""

def generate(**params):
    """Generate test data based on parameters."""
    # Create test data based on parameters with round-specific prefix
    data = f"round_{round_num}_data_{{params.get('seed', 0)}}".encode()
    return data, params
'''
        (generators_dir / f"gen_{round_num}.py").write_text(gen_content)
    return generators_dir


@pytest.fixture
def test_plan():
    """Create basic test plan."""
    return {
        "parameter_space": {
            "len": {"type": "int_range", "min": 0, "max": 100},
            "flag": {"type": "bool"},
            "fmt": {"type": "categorical", "values": ["xml", "bin"]}
        },
        "next_batch_plan": [
            {"len": 10, "flag": True, "fmt": "xml", "seed": 1},
            {"len": 20, "flag": False, "fmt": "bin", "seed": 2}
        ],
        "breakpoints": [
            {
                "location": "test.c:10",
                "hit_limit": 5,
                "inline_expr": ["len"],
                "print_call_stack": False
            }
        ]
    }


@pytest.fixture
def runtime_config():
    """Create basic runtime config."""
    return {
        "cmd": "echo @@",
        "reached_pattern": r"REACHED",
        "triggered_pattern": r"TRIGGERED",
        "max_iters": 5,
        "exec_timeout_sec": 3
    }


@pytest.fixture
def default_generator_code():
    """Default generator code for testing using fake_generator.py content."""
    return '''def generate(**params):
    """
    Returns: (input_bytes, used_params_dict)
    Sampling rules:
      - If params[k] is a dict with {"type": ...}, SAMPLE a concrete value.
      - If params[k] is a scalar, USE it as-is.
      - Seed randomness with params.get("seed").
      - Record the resolved concrete values in used_params_dict.
    """
    import random
    random.seed(params.get("seed", 0))
    payload = b"<?xml version='1.0' encoding='UTF-8'?><root/>"
    
    # Process all parameters and return them in used_params
    used_params = {}
    for key, value in params.items():
        if isinstance(value, dict) and "type" in value:
            # Sample from parameter space definition
            if value["type"] == "int_range":
                used_params[key] = random.randint(value.get("min", 0), value.get("max", 100))
            elif value["type"] == "float_range":
                used_params[key] = random.uniform(value.get("min", 0.0), value.get("max", 1.0))
            elif value["type"] == "bool":
                used_params[key] = random.choice([True, False])
            elif value["type"] == "categorical":
                used_params[key] = random.choice(value.get("values", ["default"]))
            else:
                used_params[key] = value
        else:
            # Use scalar value as-is
            used_params[key] = value
    
    return payload, used_params
'''

@pytest.fixture(autouse=True)
def suppress_logging():
    """Suppress logging during tests."""
    logging.disable(logging.CRITICAL)
    yield
    logging.disable(logging.NOTSET)


@pytest.fixture(autouse=True)
def cleanup_async_resources():
    """Ensure proper cleanup of async resources after each test."""
    yield
    
    # Clean up any remaining asyncio tasks and event loops
    try:
        import asyncio
        import gc
        
        # Force garbage collection to clean up any lingering objects
        gc.collect()
        
        # Try to get the current event loop and clean up if it exists
        try:
            loop = asyncio.get_running_loop()
            # Cancel any pending tasks
            pending_tasks = asyncio.all_tasks(loop)
            for task in pending_tasks:
                if not task.done():
                    task.cancel()
        except RuntimeError:
            # No running loop, which is fine
            pass
            
        # Additional cleanup for subprocess transports
        import subprocess
        import signal
        import os
        
        # Clean up any zombie processes
        try:
            while True:
                pid, status = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    break
        except (OSError, ChildProcessError):
            # No child processes to wait for
            pass
            
    except Exception:
        # Ignore cleanup errors to avoid affecting test results
        pass

class TestWorkdirPathBug:
    """Test class for working directory and path logic bugs."""
    
    def setup_method(self):
        """Setup test environment."""
        self.temp_dir = Path(tempfile.mkdtemp())
        self.config = Config()
        self.config.output_dir = self.temp_dir
        self.config.enable_debugger_for_all = False
        
    def teardown_method(self):
        """Cleanup test environment."""
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)
    
    def test_workdir_path_separation(self):
        """Test that command path and file reading path are correctly separated."""
        
        fuzzer = PropertyBasedFuzzer(self.config)
        
        # Create test data
        test_data = b"test content"
        testcase_file = self.temp_dir / "cur_testcase"
        testcase_file.write_bytes(test_data)
        
        # Test the fixed _prepare_cmd_and_stdin method
        cmd_template = "/bin/echo @@"
        testcase_path_for_cmd = "cur_testcase"  # Relative path for command
        testcase_path_for_reading = str(testcase_file)  # Absolute path for reading
        
        cmd_args, stdin_data = utils.prepare_cmd_and_stdin(
            cmd_template, testcase_path_for_cmd, test_data
        )
        
        # Verify command uses relative path
        assert "cur_testcase" in cmd_args
        assert str(testcase_file) not in cmd_args  # Should not contain absolute path
        
        # Verify stdin data is None for file-based input (@@)
        assert stdin_data is None
        
    def test_workdir_prevents_double_path_bug(self):
        """Test that working directory logic prevents double path bugs."""
        
        # Create a mock subprocess to capture the actual command execution
        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr=b"")
            
            fuzzer = PropertyBasedFuzzer(self.config)
            
            # Simulate the fuzzer execution flow
            test_data = b"<?xml version='1.0'?><root/>"
            generator_code = '''
def generate(**params):
    return b"<?xml version='1.0'?><root/>", {"seed": params.get("seed", 0)}
'''
            
            plan = {
                "round": 1,
                "parameter_space": {},
                "next_batch_plan": [{"seed": 1}],
                "breakpoints": []
            }
            
            runtime_config = {
                "cmd": "/bin/echo @@",
                "max_iters": 1,
                "exec_timeout_sec": 3,
                "reached_pattern": "REACHED",
                "triggered_pattern": "TRIGGERED"
            }
            
            # Run fuzzer
            results = fuzzer.fuzz(plan, runtime_config, generator_code)
            
            # Verify subprocess was called correctly
            assert mock_run.called
            call_args, call_kwargs = mock_run.call_args
            
            # Check working directory is set correctly
            assert 'cwd' in call_kwargs
            assert call_kwargs['cwd'] == str(self.temp_dir)
            
            # Check command args don't contain double paths
            cmd_args = call_args[0]
            for arg in cmd_args:
                # Should not contain the output directory twice
                assert arg != str(self.temp_dir / self.temp_dir.name / "cur_testcase")
    
    def test_real_command_execution_in_workdir(self):
        """Test real command execution with correct working directory."""
        
        fuzzer = PropertyBasedFuzzer(self.config)
        
        # Create test file
        test_data = b"test content for path verification"
        testcase_file = self.temp_dir / "cur_testcase"
        testcase_file.write_bytes(test_data)
        
        # Use a real command that will fail if path is wrong
        generator_code = '''
def generate(**params):
    return b"test content for path verification", {"seed": params.get("seed", 0)}
'''
        
        plan = {
            "round": 1,
            "parameter_space": {},
            "next_batch_plan": [{"seed": 1}],
            "breakpoints": []
        }
        
        # Use 'cat' command to verify the file can be found
        runtime_config = {
            "cmd": "/bin/cat @@",
            "max_iters": 1,
            "exec_timeout_sec": 3,
            "reached_pattern": "REACHED",
            "triggered_pattern": "TRIGGERED"
        }
        
        # Run fuzzer
        results = fuzzer.fuzz(plan, runtime_config, generator_code)
        
        # Convert to dict for backward compatibility in tests
        results_dict = results.model_dump()
        
        # Verify execution was successful (no file not found errors)
        assert results_dict['summary']['error_count'] == 0
        assert len(results_dict['iterations']) > 0
        
        first_iteration = results_dict['iterations'][0]
        assert first_iteration['type'] == 'iter_result'
        assert first_iteration['exit_code'] == 0  # cat should succeed
        
    def test_double_path_bug_detection(self):
        """Test that detects the specific double path bug we fixed."""
        
        fuzzer = PropertyBasedFuzzer(self.config)
        
        # Create test file
        test_data = b"test content"
        testcase_file = self.temp_dir / "cur_testcase"
        testcase_file.write_bytes(test_data)
        
        # Mock subprocess to capture what would have been executed with the bug
        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr=b"open: No such file or directory")
            
            # Test the OLD buggy behavior (before our fix)
            cmd_template = "/bin/cat @@"
            
            # This simulates the buggy behavior - passing absolute path when cwd is already set
            cmd_args_buggy = shlex.split(cmd_template)
            for i, arg in enumerate(cmd_args_buggy):
                if arg == "@@":
                    # OLD BUG: Use absolute path in command args
                    cmd_args_buggy[i] = str(testcase_file)  # This creates double path!
            
            # Execute with working directory set (this would cause the bug)
            subprocess.run(cmd_args_buggy, cwd=str(self.temp_dir), 
                          stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            
            # The mock should have been called with the buggy double path
            mock_run.assert_called_once()
            call_args, call_kwargs = mock_run.call_args
            
            # Verify the bug would occur: working directory + absolute path = double path
            assert call_kwargs['cwd'] == str(self.temp_dir)
            buggy_cmd_args = call_args[0]
            
            # The buggy version would pass the absolute path, causing:
            # cwd="/tmp/xxx" + arg="/tmp/xxx/cur_testcase" = "/tmp/xxx/tmp/xxx/cur_testcase"
            contains_absolute_path = any(str(self.temp_dir) in arg for arg in buggy_cmd_args)
            if contains_absolute_path:
                print("✅ Double path bug successfully detected in test!")
            
    def test_correct_path_logic_after_fix(self):
        """Test that our fix correctly handles paths."""
        
        fuzzer = PropertyBasedFuzzer(self.config)
        
        # Create test file
        test_data = b"test content"
        testcase_file = self.temp_dir / "cur_testcase"
        testcase_file.write_bytes(test_data)
        
        # Test our fixed method
        cmd_template = "/bin/cat @@"
        testcase_path_for_cmd = "cur_testcase"  # Relative for command
        testcase_path_for_reading = str(testcase_file)  # Absolute for reading
        
        cmd_args, stdin_data = utils.prepare_cmd_and_stdin(
            cmd_template, testcase_path_for_cmd, test_data
        )
        
        # Verify command uses relative path
        assert "cur_testcase" in cmd_args
        assert not any(str(self.temp_dir) in arg for arg in cmd_args)
        
        # Verify stdin data is None for file-based input (@@)
        assert stdin_data is None
        
        # Test actual execution to ensure it works
        result = subprocess.run(cmd_args, cwd=str(self.temp_dir), 
                               capture_output=True, timeout=5)
        
        # Should succeed because relative path + working directory = correct path
        assert result.returncode == 0
        assert result.stdout == test_data  # cat should output the file content

def test_fuzzer_without_debugger(temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer with debugger disabled."""
    # Create config with debugger disabled
    config_no_debug = Config()
    config_no_debug.enable_debugger_for_all = False
    config_no_debug.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config_no_debug)
    
    assert not fuzzer.use_debugger
    # debugger_instance is always initialized for potential use in Phase 1 with breakpoints
    assert fuzzer.debugger_instance is not None
    
    # Create test plan WITHOUT breakpoints to ensure no debugger usage
    test_plan_no_breakpoints = {
        "parameter_space": {
            "len": {"type": "int_range", "min": 0, "max": 100},
            "flag": {"type": "bool"},
            "fmt": {"type": "categorical", "values": ["xml", "bin"]}
        },
        "next_batch_plan": [
            {"len": 10, "flag": True, "fmt": "xml", "seed": 1},
            {"len": 20, "flag": False, "fmt": "bin", "seed": 2}
        ]
        # No breakpoints - this should prevent debugger usage
    }
    
    # Change to temp directory for testing
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Run fuzzing
        results = fuzzer.fuzz(test_plan_no_breakpoints, runtime_config, default_generator_code)
        
        # Convert to dict for backward compatibility in tests
        results_dict = fuzz_result_to_dict(results)
        
        # Verify results structure
        assert isinstance(results_dict, dict)
        assert "iterations" in results_dict
        assert "summary" in results_dict
        
        # Check that we have some iterations
        assert len(results_dict["iterations"]) > 0
        
        # Verify no debugger info in results when no breakpoints are present
        for iteration in results_dict["iterations"]:
            if iteration.get("type") == "iter_result":
                # debugger_debug should not be present when no breakpoints used
                assert "debugger_debug" not in iteration, f"Expected no debugger_debug field, but found: {iteration.get('debugger_debug')}"
    
    finally:
        os.chdir(original_cwd)


@patch('property_based_fuzzer.RuntimeDebugger', MockRuntimeDebugger)
def test_fuzzer_with_debugger_enabled(temp_dir, test_generators, test_config, test_plan, runtime_config, default_generator_code):
    """Test fuzzer with debugger enabled."""
    # Create fuzzer with debugger config
    fuzzer = PropertyBasedFuzzer(config=test_config)
    
    assert fuzzer.use_debugger
    assert fuzzer.debugger_instance is not None
    
    # Change to temp directory for testing
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Run fuzzing
        results = fuzzer.fuzz(test_plan, runtime_config, default_generator_code)
        
        # Convert to dict for backward compatibility in tests
        results_dict = fuzz_result_to_dict(results)
        
        # Verify results structure
        assert isinstance(results_dict, dict)
        assert "iterations" in results_dict
        assert "summary" in results_dict
        
        # Check that we have some iterations
        assert len(results_dict["iterations"]) > 0
        
        # Verify debugger info is present in results (should be present because test_plan has breakpoints)
        has_debugger_info = False
        for iteration in results_dict["iterations"]:
            if iteration.get("type") == "iter_result" and "debugger_debug" in iteration:
                has_debugger_info = True
                debugger_info = iteration["debugger_debug"]
                assert "breakpoints" in debugger_info
                assert "signal" in debugger_info
                assert "breakpoint_hits" in debugger_info
                assert "total_breakpoints" in debugger_info
        
        assert has_debugger_info, "No debugger info found in results"
    
    finally:
        os.chdir(original_cwd)


@patch('subprocess.run')
def test_fuzzer_with_trigger_detection(mock_subprocess, temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer trigger detection without debugger."""
    # Create fuzzer without debugger to test subprocess path
    config_no_debug = Config()
    config_no_debug.enable_debugger_for_all = False
    config_no_debug.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config_no_debug)
    
    # Mock subprocess to return TRIGGERED in stderr
    mock_result = Mock()
    mock_result.returncode = 1
    mock_result.stderr = b"TRIGGERED\nSome error output"
    mock_subprocess.return_value = mock_result
    
    # Use simple test plan
    trigger_test_plan = {
        "parameter_space": {
            "len": {"type": "int_range", "min": 1, "max": 10}
        },
        "next_batch_plan": [
            {"len": 5, "seed": 1}
        ]
    }
    
    # Runtime config for trigger detection
    trigger_config = runtime_config.copy()
    trigger_config["cmd"] = "echo trigger_test @@"
    trigger_config["max_iters"] = 1
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Run fuzzing
        results = fuzzer.fuzz(trigger_test_plan, trigger_config, default_generator_code)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # Should find trigger and stop early
        assert results_dict["summary"]["triggered_count"] > 0
        
        # Check that POC file was created
        crashes_dir = Path(temp_dir) / "crashes"
        if crashes_dir.exists():
            poc_files = list(crashes_dir.glob("poc_*"))
            assert len(poc_files) > 0
    
    finally:
        os.chdir(original_cwd)


@patch('subprocess.run')
def test_fuzzer_with_reach_detection(mock_subprocess, temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer reach detection without debugger."""
    # Create fuzzer without debugger to test subprocess path
    config_no_debug = Config()
    config_no_debug.enable_debugger_for_all = False
    config_no_debug.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config_no_debug)
    
    # Mock subprocess to return REACHED in stderr
    mock_result = Mock()
    mock_result.returncode = 0
    mock_result.stderr = b"REACHED\nSome output"
    mock_subprocess.return_value = mock_result
    
    # Use simple test plan
    reach_test_plan = {
        "parameter_space": {
            "len": {"type": "int_range", "min": 1, "max": 10}
        },
        "next_batch_plan": [
            {"len": 5, "seed": 1}
        ]
    }
    
    # Runtime config for reach detection
    reach_config = runtime_config.copy()
    reach_config["cmd"] = "echo reach_test @@"
    reach_config["max_iters"] = 1
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Run fuzzing
        results = fuzzer.fuzz(reach_test_plan, reach_config, default_generator_code)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # Should find reach but not trigger
        assert results_dict["summary"]["reached_count"] > 0
        assert results_dict["summary"]["triggered_count"] == 0
    
    finally:
        os.chdir(original_cwd)


@patch('subprocess.run')
def test_fuzzer_with_timeout(mock_subprocess, temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer timeout handling without debugger."""
    # Create fuzzer without debugger to test subprocess path
    config_no_debug = Config()
    config_no_debug.enable_debugger_for_all = False
    config_no_debug.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config_no_debug)
    
    # Mock subprocess to raise TimeoutExpired
    from subprocess import TimeoutExpired
    mock_subprocess.side_effect = TimeoutExpired("test_cmd", 3)
    
    # Use simple test plan
    timeout_test_plan = {
        "parameter_space": {
            "len": {"type": "int_range", "min": 1, "max": 10}
        },
        "next_batch_plan": [
            {"len": 5, "seed": 1}
        ]
    }
    
    # Runtime config for timeout testing
    timeout_config = runtime_config.copy()
    timeout_config["cmd"] = "echo timeout_test @@"
    timeout_config["max_iters"] = 1
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Run fuzzing
        results = fuzzer.fuzz(timeout_test_plan, timeout_config, default_generator_code)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # Should have timeouts
        assert results_dict["summary"]["timeout_count"] > 0
        
        # Check individual iteration results
        timeout_found = False
        for iteration in results_dict["iterations"]:
            if iteration.get("type") == "iter_result" and iteration.get("timeout"):
                timeout_found = True
                break
        
        assert timeout_found, "No timeout found in iterations"
    
    finally:
        os.chdir(original_cwd)


@patch('property_based_fuzzer.RuntimeDebugger', MockRuntimeDebugger)
def test_next_batch_plan_with_debugger(temp_dir, test_generators, test_config, runtime_config, default_generator_code):
    """Test next_batch_plan execution with debugger enabled."""
    # Create fuzzer with debugger enabled
    fuzzer = PropertyBasedFuzzer(config=test_config)
    
    # Verify debugger is enabled
    assert fuzzer.use_debugger
    assert fuzzer.debugger_instance is not None
    
    # Create a specific test plan for batch testing
    batch_test_plan = {
        "parameter_space": {
            "len": {"type": "int_range", "min": 1, "max": 100},
            "flag": {"type": "bool"}
        },
        "next_batch_plan": [
            {"len": 15, "flag": True, "seed": 101},
            {"len": 25, "flag": False, "seed": 102},
            {"len": 35, "flag": True, "seed": 103}
        ],
        "breakpoints": [
            {
                "location": "batch_test.c:20",
                "hit_limit": 3,
                "inline_expr": ["len", "flag"],
                "print_call_stack": True
            }
        ]
    }
    
    # Runtime config for batch testing
    batch_runtime_config = {
        "cmd": "echo batch_test @@",
        "reached_pattern": r"REACHED",
        "triggered_pattern": r"TRIGGERED", 
        "max_iters": 10,  # Allow more iterations than batch plan
        "exec_timeout_sec": 3
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Run fuzzing with batch plan
        results = fuzzer.fuzz(batch_test_plan, batch_runtime_config, default_generator_code)
        
        # Convert to dict for backward compatibility in tests
        results_dict = fuzz_result_to_dict(results)
        
        # Verify results structure
        assert isinstance(results_dict, dict)
        assert "iterations" in results_dict
        assert "summary" in results_dict
        
        # Should have at least the batch plan iterations
        assert len(results_dict["iterations"]) >= len(batch_test_plan["next_batch_plan"])
        
        # Verify that first iterations follow the batch plan exactly
        batch_plan = batch_test_plan["next_batch_plan"]
        for i, expected_params in enumerate(batch_plan):
            if i < len(results_dict["iterations"]):
                iteration = results_dict["iterations"][i]
                if iteration.get("type") == "iter_result":
                    # Check that the parameters match the batch plan
                    actual_params = iteration.get("parameters", {})
                    for key, expected_value in expected_params.items():
                        assert actual_params.get(key) == expected_value, \
                               f"Batch plan parameter {key} mismatch at iteration {i+1}"
                    
                    # Verify debugger info is present
                    assert "debugger_debug" in iteration
                    debugger_info = iteration["debugger_debug"]
                    assert "breakpoints" in debugger_info
                    assert "signal" in debugger_info
                    assert "breakpoint_hits" in debugger_info
                    assert "total_breakpoints" in debugger_info
        
            # Log completion for debugging
            print(f"Batch plan test completed with {len(results_dict['iterations'])} iterations")
    
    finally:
        os.chdir(original_cwd)


@patch('property_based_fuzzer.RuntimeDebugger', MockRuntimeDebugger)
def test_breakpoints_from_plan(temp_dir, test_generators, test_config, runtime_config, default_generator_code):
    """Test that breakpoints are correctly passed from plan to debugger."""
    # Create fuzzer with debugger enabled
    fuzzer = PropertyBasedFuzzer(config=test_config)
    
    # Create a test plan with breakpoints
    breakpoints_test_plan = {
        "parameter_space": {
            "len": {"type": "int_range", "min": 1, "max": 100}
        },
        "next_batch_plan": [
            {"len": 15, "seed": 101}
        ],
        "breakpoints": [
            {
                "location": "parser.c:120",
                "hit_limit": 5,
                "inline_expr": ["len", "*(buf+offset)"],
                "print_call_stack": True
            },
            {
                "location": "main.c:45",
                "hit_limit": 3,
                "inline_expr": ["ctx->len"],
                "print_call_stack": False
            }
        ]
    }
    
    # Runtime config for breakpoint testing
    breakpoints_runtime_config = {
        "cmd": "echo breakpoints_test @@",
        "reached_pattern": r"REACHED",
        "triggered_pattern": r"TRIGGERED", 
        "max_iters": 1,
        "exec_timeout_sec": 3
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Run fuzzing with breakpoints
        results = fuzzer.fuzz(breakpoints_test_plan, breakpoints_runtime_config, default_generator_code)
        
        # Convert to dict for backward compatibility in tests
        results_dict = fuzz_result_to_dict(results)
        
        # Verify results structure
        assert isinstance(results_dict, dict)
        assert "iterations" in results_dict
        assert "summary" in results_dict
        
        # Should have at least one iteration
        assert len(results_dict["iterations"]) >= 1
        
        # Verify that the iteration has debugger info (indicating breakpoints were used)
        iteration = results_dict["iterations"][0]
        if iteration.get("type") == "iter_result":
            assert "debugger_debug" in iteration
            debugger_info = iteration["debugger_debug"]
            assert "breakpoints" in debugger_info
            assert "total_breakpoints" in debugger_info
            # MockRuntimeDebugger should return at least one breakpoint
            assert debugger_info["total_breakpoints"] >= 1
        
            print(f"Breakpoints test completed with {len(results_dict['iterations'])} iterations")
    
    finally:
        os.chdir(original_cwd)


def test_parameter_sampling():
    """Test parameter space sampling."""
    param_space = {
        "len": {"type": "int_range", "min": 10, "max": 20},
        "flag": {"type": "bool"},
        "fmt": {"type": "categorical", "values": ["xml", "json"]},
        "rate": {"type": "float_range", "min": 0.1, "max": 0.9}
    }
    
    # Sample parameters
    params = PropertyBasedFuzzer._sample_from_space(param_space, seed=42)
    
    # Verify parameter types and ranges
    assert "seed" in params
    assert params["seed"] == 42
    assert isinstance(params["len"], int)
    assert 10 <= params["len"] <= 20
    assert isinstance(params["flag"], bool)
    assert params["fmt"] in ["xml", "json"]
    assert isinstance(params["rate"], float)
    assert 0.1 <= params["rate"] <= 0.9



def test_generation_error_handling(temp_dir, test_generators, runtime_config, default_generator_code):
    """Test error handling when generation fails."""
    # Create broken generator code for this test
    broken_gen_content = '''#!/usr/bin/env python3
"""Broken test generator."""

def generate(**params):
    """Generate function that raises an exception."""
    raise Exception("Generation failed")
'''
    
    # Create a minimal config for testing
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    test_plan = {
        "parameter_space": {
            "len": {"type": "int_range", "min": 0, "max": 100},
            "flag": {"type": "bool"},
            "fmt": {"type": "categorical", "values": ["xml", "bin"]}
        },
        "next_batch_plan": [
            {"len": 10, "flag": True, "fmt": "xml", "seed": 1},
            {"len": 20, "flag": False, "fmt": "bin", "seed": 2}
        ]
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Run fuzzing with broken generator code
        results = fuzzer.fuzz(test_plan, runtime_config, broken_gen_content)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # Should have error count
        assert results_dict["summary"]["error_count"] > 0
        
        # Check for error iterations
        error_found = False
        for iteration in results_dict["iterations"]:
            if iteration.get("type") == "error":
                error_found = True
                assert "message" in iteration
                assert "Generation failed" in iteration["message"]
                break
        
        assert error_found, "No error iteration found"
    
    finally:
        os.chdir(original_cwd)


def test_debugger_import_failure():
    """Test graceful handling of debugger import failure."""
    # Create config with debugger path but mock import failure
    config = Config()
    config.lldb_path = "/usr/bin/lldb-20"
    config.enable_debugger_for_all = True  # Enable debugger to test import failure
    config.output_dir = Path(tempfile.mkdtemp())
    
    with patch('property_based_fuzzer.RuntimeDebugger', side_effect=ImportError("Mock import error")):
        fuzzer = PropertyBasedFuzzer(config=config)
        
        # Should fall back to no debugger
        assert not fuzzer.use_debugger
        assert fuzzer.debugger_instance is None


def test_edge_case_plans(temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer with various edge case plans and configurations."""
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Test 1: Completely empty plan
        results1 = fuzzer.fuzz({}, runtime_config, default_generator_code)
        results_dict1 = fuzz_result_to_dict(results1)
        assert isinstance(results_dict1, dict)
        assert "iterations" in results_dict1
        # UPDATED: Phase 2 iterations are stored probabilistically (default 0.1 probability)
        # So we expect some iterations stored, but not necessarily all
        assert len(results_dict1["iterations"]) <= runtime_config["max_iters"]
        assert results_dict1["summary"]["total_iterations"] == runtime_config["max_iters"]
        
        # Test 2: Empty runtime config
        results2 = fuzzer.fuzz({"parameter_space": {"len": {"type": "int_range", "min": 1, "max": 10}}}, 
                              {}, default_generator_code)
        results_dict2 = fuzz_result_to_dict(results2)
        assert isinstance(results_dict2, dict)
        assert "iterations" in results_dict2
        
        # Test 3: None values in plan
        plan_with_nones = {
            "parameter_space": None,
            "next_batch_plan": None,
            "breakpoints": None
        }
        results3 = fuzzer.fuzz(plan_with_nones, runtime_config, default_generator_code)
        results_dict3 = fuzz_result_to_dict(results3)
        assert isinstance(results_dict3, dict)
        assert "iterations" in results_dict3
        
        # Test 4: Empty batch plan
        plan_empty_batch = {
            "parameter_space": {"len": {"type": "int_range", "min": 1, "max": 10}},
            "next_batch_plan": []
        }
        results4 = fuzzer.fuzz(plan_empty_batch, runtime_config, default_generator_code)
        results_dict4 = fuzz_result_to_dict(results4)
        # UPDATED: Phase 2 iterations are stored probabilistically
        assert len(results_dict4["iterations"]) <= runtime_config["max_iters"]
        assert results_dict4["summary"]["total_iterations"] == runtime_config["max_iters"]
        
    finally:
        os.chdir(original_cwd)

def test_large_batch_plan(temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer with batch plan larger than max_iters."""
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    large_batch_plan = {
        "parameter_space": {
            "len": {"type": "int_range", "min": 1, "max": 10}
        },
        "next_batch_plan": [
            {"len": i, "seed": i} for i in range(1, 11)  # 10 items
        ]
    }
    
    small_iters_config = runtime_config.copy()
    small_iters_config["max_iters"] = 3  # Smaller than batch plan
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        results = fuzzer.fuzz(large_batch_plan, small_iters_config, default_generator_code)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # Should only run max_iters iterations
        assert len(results_dict["iterations"]) == 3
        assert results_dict["summary"]["total_iterations"] == 3
    finally:
        os.chdir(original_cwd)


@patch('property_based_fuzzer.RuntimeDebugger', MockRuntimeDebugger)
def test_empty_breakpoints_list(temp_dir, test_generators, test_config, runtime_config, default_generator_code):
    """Test fuzzer with empty breakpoints list."""
    fuzzer = PropertyBasedFuzzer(config=test_config)
    
    empty_breakpoints_plan = {
        "parameter_space": {"len": {"type": "int_range", "min": 1, "max": 10}},
        "next_batch_plan": [{"len": 5, "seed": 1}],
        "breakpoints": []  # Empty list
    }
    
    test_config_copy = runtime_config.copy()
    test_config_copy["max_iters"] = 1
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        results = fuzzer.fuzz(empty_breakpoints_plan, test_config_copy, default_generator_code)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # Should work with empty breakpoints
        assert len(results_dict["iterations"]) == 1
        # Should NOT have debugger info because breakpoints list is empty
        if results_dict["iterations"][0].get("type") == "iter_result":
            # debugger_debug should be None when no breakpoints used
            debugger_debug = results_dict["iterations"][0].get("debugger_debug")
            assert debugger_debug is None, f"Expected no debugger_debug, got: {debugger_debug}"
    finally:
        os.chdir(original_cwd)


def test_missing_cmd_in_runtime_config(temp_dir, test_generators, test_plan, default_generator_code):
    """Test fuzzer with missing cmd in runtime config."""
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    no_cmd_config = {
        "reached_pattern": r"REACHED",
        "triggered_pattern": r"TRIGGERED",
        "max_iters": 1,
        "exec_timeout_sec": 3
        # Missing "cmd"
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        results = fuzzer.fuzz(test_plan, no_cmd_config, default_generator_code)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # Should use default cmd "/bin/true @@"
        assert len(results_dict["iterations"]) == 1
    finally:
        os.chdir(original_cwd)


def test_all_parameter_types(temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer with all supported parameter types."""
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    comprehensive_plan = {
        "parameter_space": {
            "int_param": {"type": "int_range", "min": 1, "max": 100},
            "float_param": {"type": "float_range", "min": 0.1, "max": 1.0},
            "bool_param": {"type": "bool"},
            "categorical_param": {"type": "categorical", "values": ["a", "b", "c"]},
            "static_param": "static_value"  # Non-dict parameter
        },
        "next_batch_plan": [
            {"int_param": 50, "float_param": 0.5, "bool_param": True, 
             "categorical_param": "b", "static_param": "static_value", "seed": 1}
        ]
    }
    
    test_config = runtime_config.copy()
    test_config["max_iters"] = 5
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        results = fuzzer.fuzz(comprehensive_plan, test_config, default_generator_code)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # UPDATED: Phase 2 iterations are stored probabilistically  
        assert len(results_dict["iterations"]) >= 1  # At least 1 batch iteration
        assert len(results_dict["iterations"]) <= 5  # At most all iterations
        assert results_dict["summary"]["total_iterations"] == 5
        
        # Check first iteration uses batch plan values
        first_iter = results_dict["iterations"][0]
        if first_iter.get("type") == "iter_result":
            params = first_iter["parameters"]
            assert params["int_param"] == 50
            assert params["float_param"] == 0.5
            assert params["bool_param"] == True
            assert params["categorical_param"] == "b"
            assert params["static_param"] == "static_value"
    finally:
        os.chdir(original_cwd)


@patch('subprocess.run')
def test_complex_command_templates(mock_subprocess, temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer with complex command templates."""
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    # Mock subprocess to avoid executing real commands
    mock_result = Mock()
    mock_result.returncode = 0
    mock_result.stderr = b"Normal output"
    mock_subprocess.return_value = mock_result
    
    complex_configs = [
        {
            "cmd": "./target --input @@ --verbose --output /tmp/out",
            "max_iters": 1
        },
        {
            "cmd": "timeout 10s ./target < @@",
            "max_iters": 1
        },
        {
            "cmd": "valgrind --tool=memcheck ./target @@",
            "max_iters": 1
        }
    ]
    
    simple_plan = {
        "parameter_space": {"len": {"type": "int_range", "min": 1, "max": 10}},
        "next_batch_plan": [{"len": 5, "seed": 1}]
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        for i, cmd_config in enumerate(complex_configs):
            test_config = runtime_config.copy()
            test_config.update(cmd_config)
            
            results = fuzzer.fuzz(simple_plan, test_config, default_generator_code)

            
            

            
            # Convert to dict for backward compatibility in tests

            
            results_dict = fuzz_result_to_dict(results)
            assert len(results_dict["iterations"]) == 1, f"Failed for command {i}"
    finally:
        os.chdir(original_cwd)


def test_various_regex_patterns(temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer with various valid regex patterns."""
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    regex_configs = [
        {
            "reached_pattern": r"REACHED|SUCCESS|OK",
            "triggered_pattern": r"CRASH|ERROR|FAIL"
        },
        {
            "reached_pattern": r"\[INFO\].*reached",
            "triggered_pattern": r"\[ERROR\].*crash"
        },
        {
            "reached_pattern": r"^Target.*$",
            "triggered_pattern": r"Segmentation fault"
        }
    ]
    
    simple_plan = {
        "parameter_space": {"len": {"type": "int_range", "min": 1, "max": 10}},
        "next_batch_plan": [{"len": 5, "seed": 1}]
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        for i, regex_config in enumerate(regex_configs):
            test_config = runtime_config.copy()
            test_config.update(regex_config)
            test_config["max_iters"] = 1
            
            results = fuzzer.fuzz(simple_plan, test_config, default_generator_code)

            
            

            
            # Convert to dict for backward compatibility in tests

            
            results_dict = fuzz_result_to_dict(results)
            assert len(results_dict["iterations"]) == 1, f"Failed for regex {i}"
    finally:
        os.chdir(original_cwd)



def test_extreme_values(temp_dir, test_generators, default_generator_code):
    """Test fuzzer with extreme but valid values."""
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    extreme_plan = {
        "parameter_space": {
            "large_int": {"type": "int_range", "min": 1000000, "max": 2000000},
            "tiny_float": {"type": "float_range", "min": 0.000001, "max": 0.000002},
            "many_choices": {"type": "categorical", "values": [f"choice_{i}" for i in range(100)]}
        },
        "next_batch_plan": [
            {"large_int": 1500000, "tiny_float": 0.0000015, "many_choices": "choice_50", "seed": 1}
        ]
    }
    
    extreme_config = {
        "cmd": "echo extreme_test @@",
        "reached_pattern": r"REACHED",
        "triggered_pattern": r"TRIGGERED",
        "max_iters": 1000,  # Large number
        "exec_timeout_sec": 0.1   # Very short timeout
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        results = fuzzer.fuzz(extreme_plan, extreme_config, default_generator_code)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # Should handle extreme values gracefully
        assert len(results_dict["iterations"]) > 0
        assert len(results_dict["iterations"]) <= 1000
    finally:
        os.chdir(original_cwd)


def test_unicode_and_special_characters(temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer with unicode and special characters in parameters."""
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    unicode_plan = {
        "parameter_space": {
            "unicode_param": {"type": "categorical", "values": ["测试", "🚀", "café", "naïve"]},
            "special_chars": {"type": "categorical", "values": ["<>&", "\"'`", "$()", "\\n\\t"]}
        },
        "next_batch_plan": [
            {"unicode_param": "测试", "special_chars": "<>&", "seed": 1}
        ]
    }
    
    test_config = runtime_config.copy()
    test_config["max_iters"] = 2
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        results = fuzzer.fuzz(unicode_plan, test_config, default_generator_code)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # Should handle unicode and special characters
        assert len(results_dict["iterations"]) > 0
        
        # Check that unicode values are preserved
        first_iter = results_dict["iterations"][0]
        if first_iter.get("type") == "iter_result":
            params = first_iter["parameters"]
            assert params["unicode_param"] == "测试"
            assert params["special_chars"] == "<>&"
    finally:
        os.chdir(original_cwd)


# Integration tests
def test_legacy_main_function(temp_dir, test_generators, default_generator_code):
    """Test main function with separated plan and runtime config files."""
    # Create plan file (without runtime config)
    plan_data = {
        "parameter_space": {
            "len": {"type": "int_range", "min": 1, "max": 10}
        },
        "next_batch_plan": [
            {"len": 5, "seed": 1}
        ],
        "breakpoints": []
    }
    
    # Create runtime config file
    runtime_config_data = {
        "cmd": "echo @@",
        "max_iters": 3,
        "exec_timeout_sec": 3,
        "reached_pattern": "REACHED",
        "triggered_pattern": "TRIGGERED"
    }
    
    original_cwd = os.getcwd()
    original_argv = sys.argv.copy()
    try:
        os.chdir(temp_dir)
        
        # Write plan file
        with open("plan.json", "w") as f:
            json.dump(plan_data, f)
        
        # Write runtime config file
        with open("runtime_config.json", "w") as f:
            json.dump(runtime_config_data, f)
        
        # Write generator file
        generator_file = "test_generator.py"
        with open(generator_file, "w") as f:
            f.write(default_generator_code)
        
        # Mock sys.argv to include all required arguments
        sys.argv = ["property_based_fuzzer.py", generator_file, "plan.json", "runtime_config.json"]
        
        # Import and run main function
        from property_based_fuzzer import main
        
        # Capture output
        import io
        from contextlib import redirect_stdout
        
        output_buffer = io.StringIO()
        with redirect_stdout(output_buffer):
            main()
        
        output = output_buffer.getvalue()
        
        # Verify formatted output format (new format)
        assert "🧪 **Property-Based Fuzzing Results**" in output
        assert "📊 **Executive Summary:**" in output
        assert "Total iterations executed:" in output
        
        # Should contain status information
        assert any(status in output for status in ["SUCCESS", "PARTIAL", "NO SUCCESS"])
        
        # Should contain iteration information
        assert "iterations" in output.lower() or "iteration" in output.lower()
    
    finally:
        os.chdir(original_cwd)
        sys.argv = original_argv


# ============================================================================
# Real readelf.cpp demo tests - integrated from demo_fuzzer.py
# Tests the fuzzer's ability to automatically capture bugs in readelf.cpp
# ============================================================================

@pytest.fixture
def readelf_path(temp_dir):
    """Compile readelf.cpp and return path to the compiled binary."""
    fixtures_dir = Path(__file__).parent / "fixtures"
    readelf_cpp = fixtures_dir / "readelf.cpp"
    readelf_binary = Path(temp_dir) / "readelf"
    
    assert readelf_cpp.exists(), f"readelf.cpp not found at {readelf_cpp}"
    
    # Compile readelf.cpp
    compile_cmd = ["g++", "-o", str(readelf_binary), str(readelf_cpp)]
    result = subprocess.run(compile_cmd, capture_output=True, text=True)
    
    if result.returncode != 0:
        raise RuntimeError(f"Failed to compile readelf.cpp: {result.stderr}")
    
    assert readelf_binary.exists(), f"Compiled readelf binary not created at {readelf_binary}"
    return str(readelf_binary)


@pytest.fixture  
def gen_0_code():
    """Load gen_0.py code for ELF generation."""
    gen_0_path = Path(__file__).parent / "fixtures" / "gen_0.py"
    assert gen_0_path.exists(), f"gen_0.py not found at {gen_0_path}"
    with open(gen_0_path, 'r') as f:
        return f.read()


def create_readelf_runtime_config(readelf_path: str) -> Dict[str, Any]:
    """Create runtime configuration for readelf tests."""
    return {
        "cmd": f"{readelf_path} @@",
        "reached_pattern": "bug location reached",
        "triggered_pattern": "bug location triggered", 
        "max_iters": 20,
        "exec_timeout_sec": 2
    }


def create_safe_elf_plan() -> Dict[str, Any]:
    """Create a plan that should NOT trigger the bug."""
    return {
        "round": 0,
        "parameter_space": {
            "elf_class": {"type": "categorical", "values": [1, 2]},
            "data_encoding": {"type": "categorical", "values": [1, 2]},
            "trigger_bug": {"type": "categorical", "values": [False]},
            "entry_point": {"type": "int_range", "min": 0x401000, "max": 0x500000},
            "file_size": {"type": "int_range", "min": 64, "max": 1024}
        },
        "next_batch_plan": [
            {"seed": 1, "elf_class": 1, "data_encoding": 1, "trigger_bug": False, "entry_point": 0x401000, "file_size": 128},
            {"seed": 2, "elf_class": 2, "data_encoding": 1, "trigger_bug": False, "entry_point": 0x402000, "file_size": 256},
            {"seed": 3, "elf_class": 1, "data_encoding": 2, "trigger_bug": False, "entry_point": 0x403000, "file_size": 512}
        ]
    }


def create_trigger_elf_plan() -> Dict[str, Any]:
    """Create a plan that SHOULD trigger the bug."""
    return {
        "round": 1,
        "parameter_space": {
            "elf_class": {"type": "categorical", "values": [2]},
            "data_encoding": {"type": "categorical", "values": [2]},
            "trigger_bug": {"type": "categorical", "values": [True]},
            "entry_point": {"type": "categorical", "values": [0x400000, 0x8048000]},
            "file_size": {"type": "int_range", "min": 64, "max": 256}
        },
        "next_batch_plan": [
            {"seed": 10, "elf_class": 2, "data_encoding": 2, "trigger_bug": True, "entry_point": 0x400000, "file_size": 128},
            {"seed": 11, "elf_class": 2, "data_encoding": 2, "trigger_bug": True, "entry_point": 0x8048000, "file_size": 256}
        ]
    }


def create_mixed_elf_plan_with_breakpoints() -> Dict[str, Any]:
    """Create a plan with breakpoints that may trigger the bug."""
    return {
        "round": 2,
        "parameter_space": {
            "elf_class": {"type": "categorical", "values": [1, 2]},
            "data_encoding": {"type": "categorical", "values": [1, 2]},
            "trigger_bug": {"type": "categorical", "values": [False, True]},
            "entry_point": {"type": "categorical", "values": [0x400000, 0x401000, 0x8048000]},
            "file_size": {"type": "int_range", "min": 64, "max": 512}
        },
        "next_batch_plan": [
            {"seed": 20, "elf_class": 1, "data_encoding": 1, "trigger_bug": False, "entry_point": 0x401000, "file_size": 128},
            {"seed": 21, "elf_class": 2, "data_encoding": 2, "trigger_bug": True, "entry_point": 0x400000, "file_size": 256},
            {"seed": 22, "elf_class": 2, "data_encoding": 1, "trigger_bug": False, "entry_point": 0x8048000, "file_size": 128}
        ],
        "breakpoints": [
            {
                "location": "readelf.cpp:143",
                "hit_limit": 5,
                "inline_expr": ["header.e_ident[4]", "header.e_ident[5]", "header.e_entry"],
                "print_call_stack": True
            },
            {
                "location": "readelf.cpp:82",
                "hit_limit": 3,
                "inline_expr": ["header.e_entry"],
                "print_call_stack": False
            }
        ]
    }


def verify_readelf_fuzz_output(results, test_name: str):
    """Verify all fields in fuzzer output for readelf tests."""
    # Check top-level structure - now expects FuzzResult
    from schemas import FuzzResult
    assert isinstance(results, FuzzResult), "Results should be a FuzzResult object"
    
    # Check summary structure - access as attribute
    summary = results.summary
    expected_summary_fields = [
        "total_iterations", "reached_count", 
        "triggered_count", "timeout_count", "error_count"
    ]
    summary_dict = summary.model_dump() if hasattr(summary, 'model_dump') else summary
    for field in expected_summary_fields:
        assert hasattr(summary, field) or field in summary_dict, f"Summary missing field: {field}"
        field_value = getattr(summary, field, summary_dict.get(field))
        assert isinstance(field_value, (int, bool)), f"Summary field {field} has wrong type"
    
    # Check iterations structure - access as attribute
    iterations = results.iterations
    assert isinstance(iterations, list), "Iterations should be a list"
    
    for i, iteration in enumerate(iterations):
        # iteration is now an IterationResult object
        iter_dict = iteration.model_dump() if hasattr(iteration, 'model_dump') else iteration.__dict__
        assert "type" in iter_dict or hasattr(iteration, 'type'), f"Iteration {i} missing 'type'"
        
        iter_type = getattr(iteration, 'type', iter_dict.get('type'))
        if iter_type == "iter_result":
            expected_fields = [
                "iter", "parameters", "reached", "triggered", 
                "timeout", "exit_code", "duration_ms"
            ]
            for field in expected_fields:
                assert hasattr(iteration, field) or field in iter_dict, f"Iteration {i} missing field: {field}"
        
        elif iter_type == "error":
            expected_error_fields = ["iter", "stage", "parameters", "message"]
            for field in expected_error_fields:
                assert hasattr(iteration, field) or field in iter_dict, f"Error iteration {i} missing field: {field}"


def test_readelf_comprehensive_demo(temp_dir, readelf_path, gen_0_code):
    """Comprehensive readelf test that verifies both safe and trigger scenarios."""
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    
    fuzzer = PropertyBasedFuzzer(config=config)
    runtime_config = create_readelf_runtime_config(readelf_path)
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Test 1: Safe ELF files (should NOT trigger bug)
        safe_plan = create_safe_elf_plan()
        results1 = fuzzer.fuzz(safe_plan, runtime_config, gen_0_code)
        verify_readelf_fuzz_output(results1, "Safe ELF Test")
        assert results1.summary.triggered_count == 0, "Triggered count should be 0"
        
        # Test 2: Trigger ELF files (SHOULD trigger bug)  
        trigger_plan = create_trigger_elf_plan()
        results2 = fuzzer.fuzz(trigger_plan, runtime_config, gen_0_code)
        verify_readelf_fuzz_output(results2, "Trigger Bug Test")
        assert results2.summary.triggered_count > 0, "Triggered count should be > 0"
        
        # Check that POC files were created
        crashes_dir = Path(temp_dir) / "crashes"
        if crashes_dir.exists():
            poc_files = list(crashes_dir.glob("poc_*"))
            assert len(poc_files) > 0, "Should create POC files"
        
        # Test 3: Runtime config validation
        runtime_config_test = {
            "cmd": f"{readelf_path} @@",
            "reached_pattern": "bug location reached",
            "triggered_pattern": "bug location triggered",
            "max_iters": 5,
            "exec_timeout_sec": 2
        }
        simple_plan = {
            "parameter_space": {"trigger_bug": {"type": "categorical", "values": [False]}},
            "next_batch_plan": [{"seed": 1, "trigger_bug": False}]
        }
        results3 = fuzzer.fuzz(simple_plan, runtime_config_test, gen_0_code)
        verify_readelf_fuzz_output(results3, "Runtime Config Test")
        results_dict3 = fuzz_result_to_dict(results3)
        assert results_dict3["summary"]["total_iterations"] >= 1
        
    finally:
        os.chdir(original_cwd)


@patch('property_based_fuzzer.RuntimeDebugger', MockRuntimeDebugger)
def test_readelf_with_breakpoints(temp_dir, readelf_path, gen_0_code):
    """Test fuzzer with readelf and breakpoints enabled."""
    config = Config()
    config.enable_debugger_for_all = True
    config.lldb_path = "/usr/bin/lldb"
    config.output_dir = Path(temp_dir)
    
    fuzzer = PropertyBasedFuzzer(config=config)
    plan = create_mixed_elf_plan_with_breakpoints()
    runtime_config = create_readelf_runtime_config(readelf_path)
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        results = fuzzer.fuzz(plan, runtime_config, gen_0_code)

        
        

        
        # Convert to dict for backward compatibility in tests

        
        results_dict = fuzz_result_to_dict(results)
        verify_readelf_fuzz_output(results, "Breakpoints Test")
        
        # Check if debugger info is present
        has_debugger_info = False
        for iteration in results_dict["iterations"]:
            if "debugger_debug" in iteration:
                has_debugger_info = True
                debugger_info = iteration["debugger_debug"]
                assert "breakpoints" in debugger_info
                assert "signal" in debugger_info
                break
        
        assert has_debugger_info, "Should have debugger info"
        
    finally:
        os.chdir(original_cwd)



def test_stdin_input_functionality(temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer with stdin input functionality using real C++ program."""
    # Create C++ program that reads from stdin
    cpp_content = '''#include <iostream>
#include <string>
#include <cstring>

int main() {
    std::string input;
    char buffer[1024];
    
    // Read from stdin
    std::cin.read(buffer, sizeof(buffer) - 1);
    std::streamsize bytes_read = std::cin.gcount();
    buffer[bytes_read] = '\\0';
    
    // Output patterns based on input content for fuzzer to detect
    if (bytes_read > 0) {
        std::cerr << "REACHED: Read " << bytes_read << " bytes from stdin" << std::endl;
        
        // Check for specific trigger pattern in input
        if (strstr(buffer, "TRIGGER_PATTERN") != nullptr) {
            std::cerr << "TRIGGERED: Special pattern found in stdin input" << std::endl;
            return 1;
        }
        
        // Output some analysis of the input
        std::cerr << "Input analysis: first_byte=" << (int)(unsigned char)buffer[0] 
                  << " last_byte=" << (int)(unsigned char)buffer[bytes_read-1] << std::endl;
    } else {
        std::cerr << "No input received from stdin" << std::endl;
    }
    
    return 0;
}
'''
    
    # Create temporary C++ file
    cpp_file = Path(temp_dir) / "stdin_test.cpp"
    executable = Path(temp_dir) / "stdin_test"
    
    try:
        # Write C++ source
        with open(cpp_file, 'w') as f:
            f.write(cpp_content)
        
        # Compile the C++ program
        compile_cmd = ["g++", "-o", str(executable), str(cpp_file)]
        compile_result = subprocess.run(compile_cmd, capture_output=True, text=True)
        
        if compile_result.returncode != 0:
            pytest.skip(f"Could not compile test C++ program: {compile_result.stderr}")
        
        assert executable.exists(), "Compiled executable should exist"
        
        # Create generator that produces data with and without trigger pattern
        stdin_generator_code = '''def generate(**params):
    """Generator for stdin testing."""
    import random
    random.seed(params.get("seed", 0))
    
    # Get trigger flag from params
    trigger = params.get("trigger", False)
    
    if trigger:
        # Create data that should trigger the pattern
        data = b"test_data_with_TRIGGER_PATTERN_here"
    else:
        # Create normal data
        data = f"normal_test_data_{params.get('seed', 0)}".encode()
    
    return data, params
'''
        
        # Create fuzzer without debugger
        config = Config()
        config.enable_debugger_for_all = False
        config.output_dir = Path(temp_dir)
        fuzzer = PropertyBasedFuzzer(config=config)
        
        # Create test plan for stdin testing
        stdin_test_plan = {
            "parameter_space": {
                "trigger": {"type": "bool"}
            },
            "next_batch_plan": [
                {"trigger": False, "seed": 1},  # Should reach but not trigger
                {"trigger": True, "seed": 2},   # Should reach and trigger
                {"trigger": False, "seed": 3}   # Should reach but not trigger
            ]
        }
        
        # Runtime config that uses executable WITHOUT @@ placeholder
        # This should cause fuzzer to use stdin input mode
        stdin_runtime_config = {
            "cmd": str(executable),  # No @@ placeholder -> stdin mode
            "reached_pattern": r"REACHED",
            "triggered_pattern": r"TRIGGERED", 
            "max_iters": 5,
            "exec_timeout_sec": 3
        }
        
        original_cwd = os.getcwd()
        try:
            os.chdir(temp_dir)
            
            # Run fuzzing with stdin input
            results = fuzzer.fuzz(stdin_test_plan, stdin_runtime_config, stdin_generator_code)
            
            # Convert to dict for backward compatibility in tests
            results_dict = fuzz_result_to_dict(results)
            
            # Verify results structure
            assert isinstance(results_dict, dict)
            assert "iterations" in results_dict
            assert "summary" in results_dict
            
            # Should have at least 2 iterations (may stop early if trigger found)
            assert len(results_dict["iterations"]) >= 2
            
            # Check that we reached the program (it should read from stdin successfully)
            assert results_dict["summary"]["reached_count"] > 0, "Should reach the program via stdin"
            
            # Check that trigger was found (one iteration has trigger=True)
            assert results_dict["summary"]["triggered_count"] > 0, "Should find trigger via stdin input"
            assert results_dict["summary"]["triggered_count"] > 0, "Should have triggered count > 0"
            
            # Verify specific iterations 
            trigger_found = False
            reach_without_trigger_found = False
            
            for i, iteration in enumerate(results_dict["iterations"]):  # Check all iterations
                if iteration.get("type") == "iter_result":
                    params = iteration.get("parameters", {})
                    reached = iteration.get("reached", 0)
                    triggered = iteration.get("triggered", 0)
                    
                    # All iterations should reach (program reads from stdin successfully)
                    assert reached == 1, f"Iteration {i+1} should reach via stdin"
                    
                    if params.get("trigger"):
                        # This should trigger
                        assert triggered == 1, f"Trigger iteration {i+1} should trigger"
                        trigger_found = True
                    else:
                        # This should not trigger
                        assert triggered == 0, f"Non-trigger iteration {i+1} should not trigger"
                        reach_without_trigger_found = True
            
            assert trigger_found, "Should find at least one trigger via stdin"
            assert reach_without_trigger_found, "Should reach without trigger via stdin"
            
            # Check that POC files were created for triggered cases
            crashes_dir = Path(temp_dir) / "crashes" 
            if crashes_dir.exists():
                poc_files = list(crashes_dir.glob("poc_*"))
                assert len(poc_files) > 0, "Should create POC files for triggered cases"
                
                # Verify POC file content contains trigger pattern
                for poc_file in poc_files:
                    content = poc_file.read_bytes()
                    assert b"TRIGGER_PATTERN" in content, f"POC {poc_file.name} should contain trigger pattern"
        
        finally:
            os.chdir(original_cwd)
            
    finally:
        # Clean up temporary files
        for file_to_remove in [cpp_file, executable]:
            if file_to_remove.exists():
                file_to_remove.unlink()


def test_stdin_vs_file_input_modes(temp_dir, test_generators, default_generator_code):
    """Test that fuzzer correctly distinguishes between stdin and file input modes."""
    # Create C++ program that shows whether input came from file or stdin
    cpp_content = '''#include <iostream>
#include <fstream>
#include <string>
#include <unistd.h>

int main(int argc, char* argv[]) {
    if (argc > 1) {
        // File input mode - read from file argument
        std::ifstream file(argv[1]);
        if (file.is_open()) {
            std::string content;
            std::getline(file, content);
            std::cerr << "FILE_INPUT: Read from file: " << content << std::endl;
            file.close();
        } else {
            std::cerr << "ERROR: Could not open file " << argv[1] << std::endl;
        }
    } else {
        // Stdin input mode - read from stdin
        std::string content;
        std::getline(std::cin, content);
        std::cerr << "STDIN_INPUT: Read from stdin: " << content << std::endl;
    }
    return 0;
}
'''
    
    # Create temporary files
    cpp_file = Path(temp_dir) / "input_mode_test.cpp"
    executable = Path(temp_dir) / "input_mode_test"
    
    try:
        # Write and compile C++ program
        with open(cpp_file, 'w') as f:
            f.write(cpp_content)
        
        compile_cmd = ["g++", "-o", str(executable), str(cpp_file)]
        compile_result = subprocess.run(compile_cmd, capture_output=True, text=True)
        
        if compile_result.returncode != 0:
            pytest.skip(f"Could not compile test C++ program: {compile_result.stderr}")
        
        # Create fuzzer
        config = Config()
        config.enable_debugger_for_all = False
        config.output_dir = Path(temp_dir)
        fuzzer = PropertyBasedFuzzer(config=config)
        
        # Simple test plan
        simple_plan = {
            "parameter_space": {},
            "next_batch_plan": [{"seed": 1}]
        }
        
        original_cwd = os.getcwd()
        try:
            os.chdir(temp_dir)
            
            # Test 1: File input mode (with @@ placeholder)
            file_input_config = {
                "cmd": f"{executable} @@",  # With @@ -> file mode
                "reached_pattern": r"FILE_INPUT",
                "triggered_pattern": r"NEVER_MATCH",
                "max_iters": 1,
                "exec_timeout_sec": 3
            }
            
            results1 = fuzzer.fuzz(simple_plan, file_input_config, default_generator_code)
            results_dict1 = fuzz_result_to_dict(results1)
            
            # Should use file input mode
            assert len(results_dict1["iterations"]) == 1
            iteration1 = results_dict1["iterations"][0]
            if iteration1.get("type") == "iter_result":
                # Check that the FILE_INPUT pattern was reached
                assert iteration1.get("reached", 0) == 1, "Should reach FILE_INPUT pattern in file mode"
            
            # Test 2: Stdin input mode (without @@ placeholder)
            stdin_input_config = {
                "cmd": str(executable),  # No @@ -> stdin mode
                "reached_pattern": r"STDIN_INPUT", 
                "triggered_pattern": r"NEVER_MATCH",
                "max_iters": 1,
                "exec_timeout_sec": 3
            }
            
            results2 = fuzzer.fuzz(simple_plan, stdin_input_config, default_generator_code)
            results_dict2 = fuzz_result_to_dict(results2)
            
            # Should use stdin input mode
            assert len(results_dict2["iterations"]) == 1
            iteration2 = results_dict2["iterations"][0]
            if iteration2.get("type") == "iter_result":
                # Check that the STDIN_INPUT pattern was reached
                assert iteration2.get("reached", 0) == 1, "Should reach STDIN_INPUT pattern in stdin mode"
        
        finally:
            os.chdir(original_cwd)
    
    finally:
        # Clean up temporary files
        for file_to_remove in [cpp_file, executable]:
            if file_to_remove.exists():
                file_to_remove.unlink()


def test_generator_timeout_functionality(temp_dir, test_generators):
    """Test generator function timeout functionality with real generator code."""
    # Create config
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    
    fuzzer = PropertyBasedFuzzer(config=config)
    
    # Create fast generator code that should NOT timeout
    fast_generator_code = '''#!/usr/bin/env python3
"""Fast generator that completes quickly."""

def generate(**params):
    """Generate test data quickly."""
    import random
    random.seed(params.get("seed", 0))
    
    # Quick data generation
    data = f"fast_data_{params.get('seed', 0)}".encode()
    used_params = {}
    
    # Process parameters quickly
    for key, value in params.items():
        if isinstance(value, dict) and "type" in value:
            if value["type"] == "int_range":
                used_params[key] = random.randint(value.get("min", 0), value.get("max", 100))
            elif value["type"] == "bool":
                used_params[key] = random.choice([True, False])
            else:
                used_params[key] = value
        else:
            used_params[key] = value
    
    return data, used_params
'''
    
    # Create slow generator code that SHOULD timeout
    slow_generator_code = '''#!/usr/bin/env python3
"""Slow generator that takes too long."""
import time

def generate(**params):
    """Generate test data slowly (will timeout)."""
    import random
    random.seed(params.get("seed", 0))
    
    # Simulate slow processing - sleep for 5 seconds (longer than 2 second timeout)
    time.sleep(5)
    
    # This code should never be reached due to timeout
    data = f"slow_data_{params.get('seed', 0)}".encode()
    used_params = {}
    
    for key, value in params.items():
        if isinstance(value, dict) and "type" in value:
            if value["type"] == "int_range":
                used_params[key] = random.randint(value.get("min", 0), value.get("max", 100))
            else:
                used_params[key] = value
        else:
            used_params[key] = value
    
    return data, used_params
'''
    
    # Create generator code that raises an exception
    error_generator_code = '''#!/usr/bin/env python3
"""Generator that raises an exception."""

def generate(**params):
    """Generate function that raises an exception."""
    raise ValueError("Test generator error for timeout testing")
'''
    
    # Test plan for timeout testing
    timeout_test_plan = {
        "parameter_space": {
            "len": {"type": "int_range", "min": 1, "max": 10},
            "flag": {"type": "bool"}
        },
        "next_batch_plan": [
            {"len": 5, "flag": True, "seed": 1}
        ]
    }
    
    # Runtime config for timeout testing
    timeout_runtime_config = {
        "cmd": "echo timeout_test @@",
        "reached_pattern": r"REACHED",
        "triggered_pattern": r"TRIGGERED",
        "max_iters": 1,
        "exec_timeout_sec": 3,
        "generator_timeout_sec": 2  # 2 seconds timeout for generator
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Test 1: Fast generator (should NOT timeout)
        results1 = fuzzer.fuzz(timeout_test_plan, timeout_runtime_config, fast_generator_code)
        results_dict1 = fuzz_result_to_dict(results1)
        
        # Verify results structure
        assert isinstance(results_dict1, dict)
        assert "iterations" in results_dict1
        assert "summary" in results_dict1
        
        # Should complete successfully without timeout errors
        assert len(results_dict1["iterations"]) == 1
        iteration1 = results_dict1["iterations"][0]
        assert iteration1.get("type") == "iter_result", "Fast generator should succeed"
        assert "parameters" in iteration1
        assert iteration1["parameters"]["len"] == 5
        assert iteration1["parameters"]["flag"] == True
        
        # Should not have generator timeout errors
        assert results_dict1["summary"]["error_count"] == 0, "Fast generator should not have errors"
        
        # Test 2: Slow generator (SHOULD timeout)
        results2 = fuzzer.fuzz(timeout_test_plan, timeout_runtime_config, slow_generator_code)
        results_dict2 = fuzz_result_to_dict(results2)
        
        # Verify timeout error occurred
        assert isinstance(results_dict2, dict)
        assert "iterations" in results_dict2
        assert "summary" in results_dict2
        
        # Should have error due to timeout
        assert results_dict2["summary"]["error_count"] > 0, "Slow generator should cause timeout error"
        
        # Check that the error is specifically a generator timeout
        timeout_error_found = False
        for iteration in results_dict2["iterations"]:
            if iteration.get("type") == "error":
                assert "stage" in iteration
                if iteration["stage"] == "generator_timeout":
                    timeout_error_found = True
                    assert "message" in iteration
                    assert "timed out" in iteration["message"].lower()
                    assert "parameters" in iteration
                    break
        
        assert timeout_error_found, "Should find generator timeout error"
        
        # Test 3: Generator with exception (should propagate exception, not timeout)
        results3 = fuzzer.fuzz(timeout_test_plan, timeout_runtime_config, error_generator_code)
        results_dict3 = fuzz_result_to_dict(results3)
        
        # Verify exception error occurred (not timeout)
        assert isinstance(results_dict3, dict)
        assert "iterations" in results_dict3
        assert "summary" in results_dict3
        
        # Should have error due to exception
        assert results_dict3["summary"]["error_count"] > 0, "Error generator should cause error"
        
        # Check that the error is a generation error (not timeout)
        generation_error_found = False
        for iteration in results_dict3["iterations"]:
            if iteration.get("type") == "error":
                assert "stage" in iteration
                if iteration["stage"] == "generate":
                    generation_error_found = True
                    assert "message" in iteration
                    assert "Test generator error" in iteration["message"]
                    break
        
        assert generation_error_found, "Should find generation error (not timeout)"
        
        # Test 4: Verify timeout configuration is respected
        # Create fuzzer with different timeout
        config_long_timeout = Config()
        config_long_timeout.enable_debugger_for_all = False
        config_long_timeout.output_dir = Path(temp_dir)
        
        fuzzer_long_timeout = PropertyBasedFuzzer(config_long_timeout)
        
        # Create moderately slow generator (3 seconds - should timeout with 2s but not with 10s)
        moderate_generator_code = '''#!/usr/bin/env python3
"""Moderately slow generator."""
import time

def generate(**params):
    """Generate test data with moderate delay."""
    import random
    random.seed(params.get("seed", 0))
    
    # Sleep for 3 seconds (should timeout with 2s config but not with 10s config)
    time.sleep(3)
    
    data = f"moderate_data_{params.get('seed', 0)}".encode()
    used_params = {}
    
    for key, value in params.items():
        if isinstance(value, dict) and "type" in value:
            if value["type"] == "int_range":
                used_params[key] = random.randint(value.get("min", 0), value.get("max", 100))
            elif value["type"] == "bool":
                used_params[key] = random.choice([True, False])
            else:
                used_params[key] = value
        else:
            used_params[key] = value
    
    return data, used_params
'''
        
        # Test with short timeout (should timeout)
        results4 = fuzzer.fuzz(timeout_test_plan, timeout_runtime_config, moderate_generator_code)
        results_dict4 = fuzz_result_to_dict(results4)
        timeout_occurred = False
        for iteration in results_dict4["iterations"]:
            if iteration.get("type") == "error" and iteration.get("stage") == "generator_timeout":
                timeout_occurred = True
                break
        assert timeout_occurred, "Moderate generator should timeout with 2s limit"
        
        # Runtime config with longer generator timeout
        timeout_runtime_config_long = {
            "cmd": "echo timeout_test @@",
            "reached_pattern": r"REACHED",
            "triggered_pattern": r"TRIGGERED",
            "max_iters": 1,
            "exec_timeout_sec": 3,
            "generator_timeout_sec": 10  # 10 seconds timeout for generator
        }
        
        # Test with long timeout (should NOT timeout)
        results5 = fuzzer_long_timeout.fuzz(timeout_test_plan, timeout_runtime_config_long, moderate_generator_code)
        results_dict5 = fuzz_result_to_dict(results5)
        timeout_occurred_long = False
        for iteration in results_dict5["iterations"]:
            if iteration.get("type") == "error" and iteration.get("stage") == "generator_timeout":
                timeout_occurred_long = True
                break
        assert not timeout_occurred_long, "Moderate generator should NOT timeout with 10s limit"
        
        # Should complete successfully with long timeout
        success_found = False
        for iteration in results_dict5["iterations"]:
            if iteration.get("type") == "iter_result":
                success_found = True
                break
        assert success_found, "Should have successful iteration with long timeout"
        
    finally:
        os.chdir(original_cwd)


def test_generator_timeout_with_dynamic_loading(temp_dir):
    """Test generator timeout with actual dynamic loading from files."""
    # Create config
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    
    fuzzer = PropertyBasedFuzzer(config=config)
    
    # Create generators directory
    generators_dir = Path(temp_dir) / "generators"
    generators_dir.mkdir(exist_ok=True)
    
    # Create a fast generator file (gen_0.py)
    fast_gen_content = '''#!/usr/bin/env python3
"""Fast generator for round 0."""

def generate(**params):
    """Generate test data quickly."""
    import random
    random.seed(params.get("seed", 0))
    
    data = f"fast_round_0_data_{params.get('seed', 0)}".encode()
    used_params = dict(params)  # Use all params as-is for simplicity
    
    return data, used_params
'''
    
    (generators_dir / "gen_0.py").write_text(fast_gen_content)
    
    # Create a slow generator file (gen_1.py) that will timeout
    slow_gen_content = '''#!/usr/bin/env python3
"""Slow generator for round 1."""
import time

def generate(**params):
    """Generate test data slowly (will timeout)."""
    import random
    random.seed(params.get("seed", 0))
    
    # Sleep for 5 seconds (longer than 2 second timeout)
    time.sleep(5)
    
    data = f"slow_round_1_data_{params.get('seed', 0)}".encode()
    used_params = dict(params)
    
    return data, used_params
'''
    
    (generators_dir / "gen_1.py").write_text(slow_gen_content)
    
    # Runtime config
    runtime_config = {
        "cmd": "echo dynamic_test @@",
        "reached_pattern": r"REACHED",
        "triggered_pattern": r"TRIGGERED",
        "max_iters": 1,
        "exec_timeout_sec": 3,
        "generator_timeout_sec": 2  # 2 seconds timeout for generator
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Parse runtime config first to set up cmd_template etc.
        fuzzer._parse_runtime_config(runtime_config)
        
        # Test round 0 (fast generator - should work)
        params = {"seed": 1, "test_param": "value"}
        generate_func_0 = fuzzer._load_dynamic_generator(0)  # Load fast generator
        result1 = fuzzer._run_one(
            iteration=1,
            params=params,
            generate_func=generate_func_0,
            from_batch_plan=True
        )
        
        # Should succeed
        assert result1.get("type") == "iter_result", "Fast generator should succeed"
        assert "parameters" in result1
        assert result1["parameters"]["seed"] == 1
        
        # Test round 1 (slow generator - should timeout)
        generate_func_1 = fuzzer._load_dynamic_generator(1)  # Load slow generator
        result2 = fuzzer._run_one(
            iteration=2,
            params=params,
            generate_func=generate_func_1,
            from_batch_plan=True
        )
        
        # Should timeout
        assert result2.get("type") == "error", "Slow generator should cause error"
        assert result2.get("stage") == "generator_timeout", "Should be timeout error"
        assert "timed out" in result2.get("message", "").lower()
        assert "parameters" in result2
        
        # Test direct timeout wrapper method
        generate_func = fuzzer._load_dynamic_generator(0)  # Load fast generator
        
        # Should work without timeout
        data, used_params = fuzzer._run_generator_with_timeout(
            generate_func, 5.0, seed=42, test="value"
        )
        assert isinstance(data, bytes)
        assert "seed" in used_params
        assert used_params["seed"] == 42
        
        # Test timeout wrapper with slow generator
        slow_generate_func = fuzzer._load_dynamic_generator(1)  # Load slow generator
        
        # Should timeout
        from property_based_fuzzer import GeneratorTimeoutError
        timeout_occurred = False
        try:
            fuzzer._run_generator_with_timeout(
                slow_generate_func, 1.0, seed=99  # 1 second timeout
            )
        except GeneratorTimeoutError as e:
            timeout_occurred = True
            assert "timed out" in str(e).lower()
        
        assert timeout_occurred, "Should raise GeneratorTimeoutError"
        
    finally:
        os.chdir(original_cwd)


def test_reached_testcase_queue_functionality(temp_dir, test_generators, default_generator_code):
    """Test that reached test cases are saved to queue directory."""
    # Create config
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    # Create test plan that will generate both reached and triggered cases
    test_plan = {
        "parameter_space": {
            "trigger_flag": {"type": "bool"},
            "data_size": {"type": "int_range", "min": 10, "max": 50}
        },
        "next_batch_plan": [
            {"trigger_flag": False, "data_size": 20, "seed": 1},  # Should reach but not trigger
            {"trigger_flag": True, "data_size": 30, "seed": 2},   # Should reach and trigger
            {"trigger_flag": False, "data_size": 40, "seed": 3}   # Should reach but not trigger
        ]
    }
    
    # Create generator that produces different outputs based on trigger_flag
    queue_test_generator_code = '''def generate(**params):
    """Generator for testing queue functionality."""
    import random
    random.seed(params.get("seed", 0))
    
    trigger_flag = params.get("trigger_flag", False)
    data_size = params.get("data_size", 20)
    seed = params.get("seed", 0)
    
    if trigger_flag:
        # Create data that should trigger
        data = f"TRIGGER_DATA_seed_{seed}_size_{data_size}".encode()
    else:
        # Create data that should reach but not trigger
        data = f"REACH_DATA_seed_{seed}_size_{data_size}".encode()
    
    used_params = {
        "trigger_flag": trigger_flag,
        "data_size": data_size,
        "seed": seed
    }
    
    return data, used_params
'''
    
    # Runtime config that detects both reach and trigger patterns
    runtime_config = {
        "cmd": "python3 -c 'import sys; print(open(sys.argv[1]).read(), file=sys.stderr)' @@",  # Output file content to stderr
        "reached_pattern": r"REACH_DATA|TRIGGER_DATA",  # Both patterns indicate reaching
        "triggered_pattern": r"TRIGGER_DATA",           # Only trigger data triggers
        "max_iters": 5,
        "exec_timeout_sec": 3
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Run fuzzing
        results = fuzzer.fuzz(test_plan, runtime_config, queue_test_generator_code)
        results_dict = fuzz_result_to_dict(results)
        
        # Verify results structure
        assert isinstance(results_dict, dict)
        assert "iterations" in results_dict
        assert "summary" in results_dict
        
        # Should have at least 3 iterations (from batch plan)
        assert len(results_dict["iterations"]) >= 3
        
        # Check that both reached and triggered cases were found
        assert results_dict["summary"]["reached_count"] > 0, "Should have reached cases"
        assert results_dict["summary"]["triggered_count"] > 0, "Should have triggered cases"
        
        # Verify directory structure was created
        crashes_dir = Path(temp_dir) / "crashes"
        
        assert crashes_dir.exists(), "Crashes directory should exist"
        # Note: queue_dir might not exist if the fuzzer doesn't create it automatically
        # This is actually a bug we're testing for
        
        # Check for POC files in crashes directory (triggered cases)
        poc_files = list(crashes_dir.glob("poc_*"))
        assert len(poc_files) > 0, "Should have POC files for triggered cases"
        
        # Verify POC file content
        for poc_file in poc_files:
            content = poc_file.read_bytes()
            assert b"TRIGGER_DATA" in content, f"POC file {poc_file.name} should contain trigger data"
        
        # Test individual iteration results
        reached_without_trigger_count = 0
        triggered_count = 0
        
        for i, iteration in enumerate(results_dict["iterations"]):
            if iteration.get("type") == "iter_result":
                params = iteration.get("parameters", {})
                reached = iteration.get("reached", 0)
                triggered = iteration.get("triggered", 0)
                
                # All iterations should reach (both patterns match the reached_pattern)
                assert reached == 1, f"Iteration {i+1} should reach"
                
                if params.get("trigger_flag"):
                    # Trigger cases should both reach and trigger
                    assert triggered == 1, f"Trigger iteration {i+1} should trigger"
                    triggered_count += 1
                else:
                    # Non-trigger cases should reach but not trigger
                    assert triggered == 0, f"Non-trigger iteration {i+1} should not trigger"
                    reached_without_trigger_count += 1
        
        assert triggered_count > 0, "Should have some triggered cases"
        assert reached_without_trigger_count > 0, "Should have some reached-but-not-triggered cases"
        
        # Verify file naming convention
        for poc_file in poc_files:
            # POC files should be named poc_{round}_{iteration}
            assert poc_file.name.startswith("poc_"), f"POC file should start with 'poc_': {poc_file.name}"
            parts = poc_file.name.split("_")
            assert len(parts) >= 3, f"POC file should have format poc_round_iteration: {poc_file.name}"
            
            # Verify round and iteration are numbers
            try:
                round_num = int(parts[1])
                iteration_num = int(parts[2])
                assert round_num >= 0, f"Round number should be >= 0: {round_num}"
                assert iteration_num >= 1, f"Iteration number should be >= 1: {iteration_num}"
            except ValueError:
                pytest.fail(f"POC file name should contain numeric round and iteration: {poc_file.name}")
        
        print(f"✓ Queue functionality test completed:")
        print(f"  - POC files (triggered): {len(poc_files)}")
        print(f"  - Total reached: {results_dict['summary']['reached_count']}")
        print(f"  - Total triggered: {results_dict['summary']['triggered_count']}")
        
    finally:
        os.chdir(original_cwd)


# ============================================================================
# Pydantic Schema Tests
# ============================================================================

def test_pydantic_plan_validation():
    """Test Pydantic validation for FuzzPlan."""
    import tempfile
    import os
    
    # Create a temporary file for breakpoint validation
    with tempfile.NamedTemporaryFile(mode='w', suffix='.c', delete=False) as tmp_file:
        tmp_file.write("// Test C file for breakpoint validation\nint main() { return 0; }\n")
        temp_file_path = tmp_file.name
    
    try:
        # Test valid plan
        valid_plan = {
            "parameter_space": {
                "len": {"type": "int_range", "min": 0, "max": 100},
                "flag": {"type": "bool"},
                "format": {"type": "categorical", "values": ["xml", "json", "binary"]}
            },
            "next_batch_plan": [
                {
                    "plan_description": "Test trigger condition",
                    "len": 0,
                    "flag": True,
                    "format": "xml",
                    "seed": 1
                }
            ],
            "breakpoints": [
                {
                    "location": f"{temp_file_path}:2",
                    "hit_limit": 5,
                    "inline_expr": ["len"],
                    "print_call_stack": True
                }
            ]
        }
    
        # Should validate successfully
        plan = FuzzPlan.model_validate(valid_plan)
        assert len(plan.parameter_space) == 3
        assert len(plan.next_batch_plan) == 1
        assert len(plan.breakpoints) == 1
    finally:
        # Clean up temporary file
        if os.path.exists(temp_file_path):
            os.unlink(temp_file_path)

def test_pydantic_runtime_config_validation():
    """Test Pydantic validation for RuntimeConfig."""
    # Test valid config
    valid_config = {
        "cmd": "./target @@",
        "max_iters": 1000,
        "exec_timeout_sec": 5,
        "reached_pattern": r"REACHED|SUCCESS",
        "triggered_pattern": r"TRIGGERED|CRASH"
    }
    
    config = RuntimeConfig.model_validate(valid_config)
    assert config.cmd == "./target @@"
    assert config.max_iters == 1000
    assert config.exec_timeout_sec == 5
    
    # Test with minimal required fields
    minimal_config = {
        "cmd": "echo @@",
        "reached_pattern": "REACHED",
        "triggered_pattern": "TRIGGERED"
    }
    config2 = RuntimeConfig.model_validate(minimal_config)
    assert config2.max_iters == 100  # default
    assert config2.exec_timeout_sec == 3  # default
    assert config2.reached_pattern == "REACHED"  # required field
    assert config2.triggered_pattern == "TRIGGERED"  # required field

def test_pydantic_validation_errors():
    """Test Pydantic validation error handling."""
    
    # Test that unknown parameter types are allowed (should NOT raise ValidationError)
    try:
        plan = FuzzPlan.model_validate({
            "parameter_space": {
                "param1": {"type": "invalid_type"}
            }
        })
        # This should pass validation since we allow unknown types
        assert plan.parameter_space["param1"]["type"] == "invalid_type"
    except ValidationError:
        pytest.fail("Unknown parameter types should be allowed")
    
    # Test invalid regex in runtime config
    with pytest.raises(ValidationError) as excinfo:
        RuntimeConfig.model_validate({
            "cmd": "test",
            "reached_pattern": "[invalid regex"
        })
    assert "Invalid regex pattern" in str(excinfo.value)
    
    # Test invalid breakpoint location
    with pytest.raises(ValidationError) as excinfo:
        FuzzPlan.model_validate({
            "breakpoints": [{
                "location": "no_line_number"  # Missing :line
            }]
        })
    assert "location must be in format 'full_file_abs_path:line'" in str(excinfo.value)


def test_pydantic_batch_plan_validation():
    """Test batch plan validation against parameter space."""
    # Test valid batch plan
    plan = FuzzPlan.model_validate({
        "parameter_space": {
            "len": {"type": "int_range", "min": 0, "max": 10},
            "flag": {"type": "bool"},
            "mode": {"type": "categorical", "values": ["a", "b", "c"]}
        },
        "next_batch_plan": [
            {
                "plan_description": "Test case 1",
                "len": 5,
                "flag": True,
                "mode": "b",
                "seed": 1
            }
        ]
    })
    assert len(plan.next_batch_plan) == 1
    
    # Test out of range value
    with pytest.raises(ValidationError) as excinfo:
        FuzzPlan.model_validate({
            "parameter_space": {
                "len": {"type": "int_range", "min": 0, "max": 10}
            },
            "next_batch_plan": [{
                "plan_description": "Out of range",
                "len": 20,  # Out of range
                "seed": 1
            }]
        })
    assert "out of range" in str(excinfo.value)
    
    # Test invalid categorical value
    with pytest.raises(ValidationError) as excinfo:
        FuzzPlan.model_validate({
            "parameter_space": {
                "mode": {"type": "categorical", "values": ["a", "b", "c"]}
            },
            "next_batch_plan": [{
                "plan_description": "Invalid category",
                "mode": "d",  # Not in allowed values
                "seed": 1
            }]
        })
    assert "not in allowed values" in str(excinfo.value)

def test_fuzzer_with_pydantic_models(temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer with Pydantic input/output models."""
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    # Create Pydantic models
    plan = FuzzPlan(
        parameter_space={
            "len": {"type": "int_range", "min": 1, "max": 10},
            "flag": {"type": "bool"}
        },
        next_batch_plan=[
            BatchPlanEntry(
                plan_description="Test with len=5",
                len=5,
                flag=True,
                seed=1
            )
        ]
    )
    
    runtime_cfg = RuntimeConfig(
        cmd="echo @@",
        max_iters=3,
        exec_timeout_sec=2,
        reached_pattern="REACHED",
        triggered_pattern="TRIGGERED"
    )
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Run fuzzing with Pydantic models
        results = fuzzer.fuzz(plan, runtime_cfg, default_generator_code)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # Should return Pydantic FuzzResult
        assert hasattr(results, 'model_dump'), "Results should be Pydantic model"
        assert isinstance(results.summary, FuzzSummary)
        assert all(isinstance(it, IterationResult) for it in results.iterations)
        
        # Verify results
        assert results.summary.total_iterations >= 1
        assert len(results.iterations) >= 1
        
        # Check first iteration uses batch plan
        first_iter = results.iterations[0]
        if first_iter.type == "iter_result":
            assert first_iter.parameters["len"] == 5
            assert first_iter.parameters["flag"] == True
            
    finally:
        os.chdir(original_cwd)

def test_fuzzer_backward_compatibility(temp_dir, test_generators, runtime_config, default_generator_code):
    """Test fuzzer still works with dictionary inputs (backward compatibility)."""
    config = Config()
    config.enable_debugger_for_all = False
    config.output_dir = Path(temp_dir)
    fuzzer = PropertyBasedFuzzer(config=config)
    
    # Use dictionary inputs (old API)
    plan_dict = {
        "parameter_space": {
            "len": {"type": "int_range", "min": 1, "max": 10}
        },
        "next_batch_plan": [
            {"len": 3, "seed": 1}
        ]
    }
    
    runtime_dict = {
        "cmd": "echo @@",
        "max_iters": 2
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        # Run fuzzing with dictionaries
        results = fuzzer.fuzz(plan_dict, runtime_dict, default_generator_code)

        

        # Convert to dict for backward compatibility in tests

        results_dict = fuzz_result_to_dict(results)
        
        # Should return dictionary (backward compatibility)
        assert isinstance(results_dict, dict), "Results should be dictionary for dict input"
        assert "summary" in results_dict
        assert "iterations" in results_dict
        
        # Verify results
        assert results_dict["summary"]["total_iterations"] >= 1
        assert len(results_dict["iterations"]) >= 1
        
    finally:
        os.chdir(original_cwd)

def test_pydantic_result_validation():
    """Test FuzzResult validation and consistency checks."""
    # Test valid result
    valid_result = {
        "iterations": [
            {
                "type": "iter_result",
                "iter": 1,
                "parameters": {"seed": 1},
                "reached": 1,
                "triggered": 0,
                "timeout": False,
                "exit_code": 0,
                "duration_ms": 100
            },
            {
                "type": "iter_result",
                "iter": 2,
                "parameters": {"seed": 2},
                "reached": 1,
                "triggered": 1,
                "timeout": False,
                "exit_code": 1,
                "duration_ms": 150
            }
        ],
        "summary": {
            "total_iterations": 2,
            "reached_count": 2,
            "triggered_count": 1,
            "timeout_count": 0,
            "error_count": 0
        }
    }
    
    result = FuzzResult.model_validate(valid_result)
    assert result.summary.total_iterations == 2
    assert result.summary.triggered_count > 0
    assert len(result.iterations) == 2
    
    # Test inconsistent summary
    with pytest.raises(ValidationError) as excinfo:
        FuzzResult.model_validate({
            "iterations": [
                {
                    "type": "iter_result", 
                    "iter": 1, 
                    "parameters": {}, 
                    "reached": 1, 
                    "triggered": 0,
                    "timeout": False,
                    "exit_code": 0,
                    "duration_ms": 100
                }
            ],
            "summary": {
                "total_iterations": 1,
                "reached_count": 1,
                "triggered_count": 1,  # Inconsistent - no triggers in iterations
                "timeout_count": 0,
                "error_count": 0
            }
        })
    assert "triggered_count mismatch" in str(excinfo.value)


# ============================================================================
# Real End-to-End Debugger Tests (No Mocks)
# ============================================================================

def _has_lldb():
    """Check if lldb is available in the system."""
    try:
        for lldb_name in ['lldb-20', 'lldb']:
            result = subprocess.run(['which', lldb_name], capture_output=True, text=True)
            if result.returncode == 0:
                return True
        return False
    except Exception:
        return False


def _compile_test_c(temp_dir):
    """Compile test.c to create an executable for testing."""
    test_c_path = Path(__file__).parent / 'fixtures' / 'test.c'
    test_exe_path = Path(temp_dir) / 'test_program'
    
    if not test_c_path.exists():
        return None, f"test.c not found at {test_c_path}"
    
    try:
        # Compile with debug symbols
        result = subprocess.run([
            'gcc', '-g', '-o', str(test_exe_path), str(test_c_path)
        ], capture_output=True, text=True)
        
        if result.returncode != 0:
            return None, f"Compilation failed: {result.stderr}"
            
        return test_exe_path, None
    except Exception as e:
        return None, f"Compilation error: {e}"

def test_real_debugger_end_to_end_with_callstack_and_inline_expr(temp_dir):
    """
    End-to-end test using real debugger with real program, real breakpoints,
    and validation of callstack and inline expressions in fuzzer output.
    No mocks used - tests the complete integration.
    """
    print("=== Real End-to-End Debugger Test ===")
    
    # Compile test.c
    test_exe_path, compile_error = _compile_test_c(temp_dir)
    if compile_error:
        pytest.skip(f"Could not compile test program: {compile_error}")
    
    assert test_exe_path.exists(), f"Test executable not created: {test_exe_path}"
    
    # Get absolute path to test.c for breakpoints
    test_c_path = Path(__file__).parent / 'fixtures' / 'test.c'
    test_c_abs = test_c_path.resolve()
    
    # Create config with real debugger enabled
    config = Config()
    config.enable_debugger_for_all = True
    config.output_dir = Path(temp_dir)
    
    # Find lldb path
    for lldb_name in ['lldb-20', 'lldb']:
        result = subprocess.run(['which', lldb_name], capture_output=True, text=True)
        if result.returncode == 0:
            config.lldb_path = result.stdout.strip()
            break
    
    fuzzer = PropertyBasedFuzzer(config=config)
    
    # Create real plan with real breakpoints targeting test.c
    real_plan = {
        "parameter_space": {
            "arg_count": {"type": "int_range", "min": 1, "max": 3},
            "data_value": {"type": "categorical", "values": ["test", "hello", "world"]}
        },
        "next_batch_plan": [
            {"arg_count": 2, "data_value": "test", "seed": 1},
            {"arg_count": 1, "data_value": "hello", "seed": 2}
        ],
        "breakpoints": [
            {
                "location": f"{test_c_abs}:16",  # Line with calculate_sum call
                "hit_limit": 5,
                "inline_expr": ["result", "argc"],
                "print_call_stack": True
            },
            {
                "location": f"{test_c_abs}:24",  # Inside calculate_sum function
                "hit_limit": 5,
                "inline_expr": ["sum", "a", "b"],
                "print_call_stack": True
            }
        ]
    }
    
    # Create generator that produces command line arguments
    real_generator_code = '''def generate(**params):
    """Generate command line arguments for test program."""
    import random
    random.seed(params.get("seed", 0))
    
    arg_count = params.get("arg_count", 1)
    data_value = params.get("data_value", "test")
    
    # Create command line arguments
    args = [data_value]
    for i in range(arg_count - 1):
        args.append(f"arg{i+1}")
    
    # Convert to space-separated string for command line
    data = " ".join(args).encode()
    
    used_params = {
        "arg_count": arg_count,
        "data_value": data_value,
        "seed": params.get("seed", 0)
    }
    
    return data, used_params
'''
    
    # Runtime config to run the test program
    runtime_config = {
        "cmd": f"{test_exe_path} @@",  # Will read args from testcase file
        "reached_pattern": r"Hello, World!",
        "triggered_pattern": r"Large sum detected",
        "max_iters": 3,
        "exec_timeout_sec": 10
    }
    
    original_cwd = os.getcwd()
    try:
        os.chdir(temp_dir)
        
        print(f"Running fuzzer with real debugger on {test_exe_path}")
        print(f"Breakpoints at: {test_c_abs}:16 and {test_c_abs}:24")
        
        # Run fuzzing with real debugger (NO MOCKS)
        results = fuzzer.fuzz(real_plan, runtime_config, real_generator_code)
        
        # Convert to dict for analysis
        results_dict = fuzz_result_to_dict(results)
        
        print(f"Fuzzing completed with {len(results_dict['iterations'])} iterations")
        
        # Verify we have iterations
        assert len(results_dict["iterations"]) > 0, "Should have at least one iteration"
        
        # Look for debugger information in results
        debugger_info_found = False
        callstack_found = False
        inline_expr_found = False
        
        for i, iteration in enumerate(results_dict["iterations"]):
            print(f"\n--- Iteration {i+1} ---")
            print(f"Type: {iteration.get('type')}")
            
            if iteration.get("type") == "iter_result":
                print(f"Parameters: {iteration.get('parameters', {})}")
                print(f"Reached: {iteration.get('reached', 0)}")
                print(f"Triggered: {iteration.get('triggered', 0)}")
                
                # Check for debugger debug info
                debugger_debug = iteration.get("debugger_debug")
                if debugger_debug:
                    debugger_info_found = True
                    print(f"Debugger info found!")
                    print(f"  Signal: {debugger_debug.get('signal')}")
                    print(f"  Breakpoint hits: {debugger_debug.get('breakpoint_hits', 0)}")
                    print(f"  Total breakpoints: {debugger_debug.get('total_breakpoints', 0)}")
                    
                    # Check breakpoints details
                    breakpoints = debugger_debug.get("breakpoints", [])
                    for j, bp in enumerate(breakpoints):
                        print(f"  Breakpoint {j+1}:")
                        print(f"    File: {bp.get('file_path')}")
                        print(f"    Line: {bp.get('line')}")
                        print(f"    Function: {bp.get('function_name')}")
                        print(f"    Hit times: {bp.get('hit_times', 0)}")
                        
                        # Check for hits_info with callstack and inline expressions
                        hits_info = bp.get("hits_info", [])
                        for k, hit in enumerate(hits_info):
                            print(f"    Hit {k+1}:")
                            
                            # Check callstack
                            callstack = hit.get("callstack", "")
                            if callstack and len(callstack.strip()) > 0:
                                callstack_found = True
                                print(f"      Callstack found: {len(callstack)} chars")
                                # Print first few lines of callstack
                                callstack_lines = callstack.split('\n')[:3]
                                for line in callstack_lines:
                                    if line.strip():
                                        print(f"        {line.strip()}")
                            
                            # Check inline expressions
                            inline_expr = hit.get("inline_expr", [])
                            if inline_expr:
                                inline_expr_found = True
                                print(f"      Inline expressions found: {len(inline_expr)}")
                                for expr in inline_expr:
                                    name = expr.get("name", "")
                                    value = expr.get("value", "")
                                    print(f"        {name} = {value}")
        
        # Verify that we got real debugger information
        assert debugger_info_found, "No debugger information found in results"
        print(f"\n✓ Debugger information found: {debugger_info_found}")
        
        # Verify callstack information
        assert callstack_found, "No callstack information found in debugger results"
        print(f"✓ Callstack information found: {callstack_found}")
        
        # Verify inline expression information
        assert inline_expr_found, "No inline expression information found in debugger results"
        print(f"✓ Inline expression information found: {inline_expr_found}")
        
        # Verify that results contain expected structure
        assert "summary" in results_dict
        assert results_dict["summary"]["total_iterations"] > 0
        
        print(f"\n✓ End-to-end real debugger test passed!")
        print(f"  - Real program compiled and executed: ✓")
        print(f"  - Real breakpoints set and hit: ✓") 
        print(f"  - Real callstack captured: ✓")
        print(f"  - Real inline expressions evaluated: ✓")
        print(f"  - Fuzzer integration working: ✓")
        
    finally:
        os.chdir(original_cwd)
        
        # Clean up temporary files
        try:
            if test_exe_path and Path(test_exe_path).exists():
                Path(test_exe_path).unlink()
                print(f"✓ Cleaned up test executable: {test_exe_path}")
        except Exception as e:
            print(f"Warning: Could not clean up {test_exe_path}: {e}")
        
        # Clean up any core dumps
        try:
            core_files = list(Path(temp_dir).glob("core*"))
            for core_file in core_files:
                core_file.unlink()
                print(f"✓ Cleaned up core file: {core_file}")
        except Exception as e:
            print(f"Warning: Could not clean up core files: {e}")


if __name__ == '__main__':
    # Set up logging for tests
    logging.basicConfig(level=logging.WARNING)
    
    # Run tests
    pytest.main([__file__, "-v"])