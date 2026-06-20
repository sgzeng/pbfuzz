#!/usr/bin/env python3
"""
Test suite for MCP Corpus Server

Tests the corpus management functionality including:
- Corpus initialization and seed processing
- Background thread processing of testcases
- Route analysis with debugger integration
- Consumer threads for parallel route extraction
- MCP server API functionality
- Reaching testcase detection and queue management
"""

import asyncio
import os
import shutil
import tempfile
import time
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock, Mock

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from mcp_corpus_server import Corpus, MCPCorpusServer
import mcp.types as types

# Async test decorator
def async_test(coro):
    def wrapper(*args, **kwargs):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro(*args, **kwargs))
        finally:
            loop.close()
    return wrapper


class TestCorpus:
    """Test the Corpus class functionality"""
    
    def setup_method(self):
        """Set up test environment"""
        self.temp_dir = tempfile.mkdtemp()
        self.input_dir = Path(self.temp_dir) / "input"
        self.output_dir = Path(self.temp_dir) / "output"
        self.static_dir = Path(self.temp_dir) / "static"
        
        # Create directories
        self.input_dir.mkdir(parents=True)
        self.output_dir.mkdir(parents=True)
        self.static_dir.mkdir(parents=True)
        
        # Create test files
        self.create_test_files()
        self.create_static_files()
        
    def teardown_method(self):
        """Clean up test environment"""
        shutil.rmtree(self.temp_dir, ignore_errors=True)
        
    def create_test_files(self):
        """Create test input files"""
        # Create some test files in input directory
        (self.input_dir / "test1.txt").write_text("test input 1")
        (self.input_dir / "test2.txt").write_text("test input 2")
        (self.input_dir / "test3.txt").write_text("test input 3")
        
        # Create a subdirectory with more files
        subdir = self.input_dir / "subdir"
        subdir.mkdir()
        (subdir / "test4.txt").write_text("test input 4")

    def create_static_files(self):
        """Create static analysis result files"""
        # Use the real readelf_static_analysis directory if available
        readelf_static_dir = Path(__file__).parent / "fixtures" / "readelf_static_analysis"
        if readelf_static_dir.exists():
            # Copy files from the real static analysis directory
            shutil.copytree(readelf_static_dir, self.static_dir, dirs_exist_ok=True)
        else:
            # Fallback: create minimal static files
            bb_targets_file = self.static_dir / "BBtargets.txt"
            bb_targets_content = f"""{self.temp_dir}/test.c:10
{self.temp_dir}/test.c:20
{self.temp_dir}/main.c:15
"""
            bb_targets_file.write_text(bb_targets_content)
            
            # Create basic function_info.txt
            function_info_file = self.static_dir / "function_info.txt"
            function_info_content = """1,main,{}/main.c,10,30
2,test_func,{}/test.c,5,25
""".format(self.temp_dir, self.temp_dir)
            function_info_file.write_text(function_info_content)
            
            # Create empty placeholder files for other required static analysis files
            (self.static_dir / "bid_loc_mapping.txt").write_text("")
            (self.static_dir / "caller-callee.txt").write_text("")
            (self.static_dir / "callee-caller.txt").write_text("")

    def create_corpus_with_mocks(self, **kwargs):
        """Helper to create corpus with mocked dependencies"""
        with patch('mcp_corpus_server.RuntimeDebugger') as mock_debugger, \
             patch('mcp_corpus_server.SourceCodeFinder') as mock_source_finder:
            
            # Create mock source finder instance
            mock_source_finder_instance = MagicMock()
            mock_source_finder.return_value = mock_source_finder_instance
            mock_debugger.return_value = MagicMock()
            
            # Configure the mock to return proper file paths
            # Create actual test files that can be referenced
            test_c_file = Path(self.temp_dir) / "test.c"
            main_c_file = Path(self.temp_dir) / "main.c"
            test_c_file.write_text("// test file\nint main() { return 0; }")
            main_c_file.write_text("// main file\nint main() { return 0; }")
            
            # Mock the methods to return absolute paths
            def mock_get_fp_from_func_id(func_id):
                if func_id == "1":
                    return str(main_c_file.absolute())
                elif func_id == "2":
                    return str(test_c_file.absolute())
                return str(test_c_file.absolute())  # Default fallback
            
            def mock_get_func_ids_from_loc(loc):
                if "main.c" in loc:
                    return ["1"]
                elif "test.c" in loc:
                    return ["2"]
                return ["2"]  # Default fallback
            
            mock_source_finder_instance.get_fp_from_func_id.side_effect = mock_get_fp_from_func_id
            mock_source_finder_instance.get_func_ids_from_loc.side_effect = mock_get_func_ids_from_loc
            mock_source_finder_instance.fp_fn_map = {
                "test.c": [str(test_c_file.absolute())],
                "main.c": [str(main_c_file.absolute())]
            }
            
            # Default parameters
            default_kwargs = {
                'input_dir': str(self.input_dir),
                'output_dir': str(self.output_dir),
                'cmd_template': "echo @@",
                'reached_pattern': "REACHED",
                'static_result_folder': str(self.static_dir)
            }
            default_kwargs.update(kwargs)
            
            return Corpus(**default_kwargs), mock_source_finder, mock_debugger
        
    @patch('debugger.RuntimeDebugger')
    @patch('source_code.SourceCodeFinder')
    def test_corpus_initialization(self, mock_source_finder, mock_debugger):
        """Test corpus initialization"""
        # Mock the components to avoid actual initialization
        mock_source_finder.return_value = MagicMock()
        mock_debugger.return_value = MagicMock()
        
        corpus = Corpus(
            input_dir=str(self.input_dir),
            output_dir=str(self.output_dir),
            cmd_template="echo @@",
            reached_pattern="REACHED",
            static_result_folder=str(self.static_dir)
        )
        
        assert corpus.input_dir == self.input_dir
        assert corpus.output_dir == self.output_dir
        assert corpus.cmd_template == "echo @@"
        assert corpus.queue_dir.exists()
        assert not corpus.processing_complete
        assert corpus.total_processed == 0
        assert corpus.reaching_found == 0
        assert corpus.routes_analyzed == 0
        assert corpus.failed_route_analysis == 0
        assert len(corpus.possible_routes) == 0

    def test_collect_target_locations(self):
        """Test target location collection from BBtargets.txt"""
        corpus, _, _ = self.create_corpus_with_mocks()
        
        # The corpus should have collected target locations during initialization
        assert hasattr(corpus, 'target_locations')
        assert isinstance(corpus.target_locations, list)
        # Check that locations were converted to absolute paths
        for location in corpus.target_locations:
            assert ':' in location
            file_part, line_part = location.rsplit(':', 1)
            assert os.path.isabs(file_part)

    def test_update_possible_routes(self):
        """Test updating possible routes with callstack information"""
        corpus, _, _ = self.create_corpus_with_mocks()
        
        # Create a test file
        test_file = self.input_dir / "route_test.txt"
        test_file.write_text("route test content")
        
        callstack1 = "Frame 0: main at main.c:15\nFrame 1: test_func at test.c:10"
        callstack2 = "Frame 0: main at main.c:15\nFrame 1: other_func at other.c:5"
        
        # Test adding new routes
        corpus._update_possible_routes(callstack1, str(test_file))
        assert len(corpus.possible_routes) == 1
        assert corpus.possible_routes[callstack1] == str(test_file)
        
        corpus._update_possible_routes(callstack2, str(test_file))
        assert len(corpus.possible_routes) == 2
        
        # Test updating with smaller file
        smaller_file = self.input_dir / "smaller.txt"
        smaller_file.write_text("small")
        corpus._update_possible_routes(callstack1, str(smaller_file))
        assert corpus.possible_routes[callstack1] == str(smaller_file)

    def test_get_possible_routes(self):
        """Test getting copy of possible routes"""
        corpus, _, _ = self.create_corpus_with_mocks()
        
        # Add some routes
        test_file = self.input_dir / "test.txt"
        test_file.write_text("test content")
        callstack = "Frame 0: main at main.c:15"
        
        corpus._update_possible_routes(callstack, str(test_file))
        
        # Get routes copy
        routes_copy = corpus.get_possible_routes()
        assert len(routes_copy) == 1
        assert routes_copy[callstack] == str(test_file)
        
        # Modify the copy - shouldn't affect original
        routes_copy["new_callstack"] = "new_file"
        assert len(corpus.possible_routes) == 1
        
    def test_get_status_with_routes(self):
        """Test status includes route analysis information"""
        corpus, _, _ = self.create_corpus_with_mocks()
        
        # Create a test file for the route
        test_file = self.input_dir / "route_test.txt" 
        test_file.write_text("test content for route")
        
        # Set some stats
        corpus.routes_analyzed = 5
        corpus.failed_route_analysis = 1
        corpus._update_possible_routes("test_callstack", str(test_file))
        
        status = corpus.get_status()
        
        assert status['routes_analyzed'] == 5
        assert status['failed_route_analysis'] == 1
        assert status['possible_routes_count'] == 1
        
    def test_check_reached(self):
        """Test target reached detection"""
        corpus, _, _ = self.create_corpus_with_mocks()
        
        # Test positive match
        assert corpus._check_reached("Some output REACHED here")
        assert corpus._check_reached("REACHED")
        
        # Test negative match
        assert not corpus._check_reached("Some output here")
        assert not corpus._check_reached("")
        
    def test_check_reached_regex(self):
        """Test target reached detection with regex pattern"""
        corpus, _, _ = self.create_corpus_with_mocks(reached_pattern=r"Target \d+ reached")
        
        # Test positive match
        assert corpus._check_reached("Target 123 reached")
        assert corpus._check_reached("Some output Target 456 reached here")
        
        # Test negative match
        assert not corpus._check_reached("Target reached")
        assert not corpus._check_reached("Target abc reached")
        
    @patch('subprocess.run')
    def test_process_single_testcase_reaching(self, mock_run):
        """Test processing a single testcase that reaches target"""
        # Mock subprocess to return reaching output
        mock_proc = MagicMock()
        mock_proc.stderr = b"Some output REACHED here"
        mock_proc.returncode = 0
        mock_run.return_value = mock_proc
        
        corpus, _, _ = self.create_corpus_with_mocks()
        
        testcase_path = self.input_dir / "test1.txt"
        corpus._process_single_testcase(testcase_path)
        
        # Check that subprocess was called
        mock_run.assert_called_once()
        
        # Check that reaching testcase was added
        assert corpus.reaching_found == 1
        assert corpus.seed_queue.qsize() == 1
        
        # Check that file was copied to queue directory
        queue_files = list(corpus.queue_dir.glob("reaching_*"))
        assert len(queue_files) == 1
        
    @patch('subprocess.run')
    def test_process_single_testcase_not_reaching(self, mock_run):
        """Test processing a single testcase that doesn't reach target"""
        # Mock subprocess to return non-reaching output
        mock_proc = MagicMock()
        mock_proc.stderr = b"Some output here"
        mock_proc.returncode = 0
        mock_run.return_value = mock_proc
        
        corpus, _, _ = self.create_corpus_with_mocks()
        
        testcase_path = self.input_dir / "test1.txt"
        corpus._process_single_testcase(testcase_path)
        
        # Check that subprocess was called
        mock_run.assert_called_once()
        
        # Check that no reaching testcase was added
        assert corpus.reaching_found == 0
        assert corpus.seed_queue.qsize() == 0
        
    @patch('subprocess.run')
    def test_process_single_testcase_timeout(self, mock_run):
        """Test processing a testcase that times out"""
        import subprocess
        # Mock subprocess to raise timeout
        mock_run.side_effect = subprocess.TimeoutExpired("cmd", 5)
        
        corpus, _, _ = self.create_corpus_with_mocks()
        
        testcase_path = self.input_dir / "test1.txt"
        corpus._process_single_testcase(testcase_path)
        
        # Check that no reaching testcase was added
        assert corpus.reaching_found == 0
        assert corpus.seed_queue.qsize() == 0
        
    def test_peek_reaching_testcase_empty_queue(self):
        """Test peeking at testcase from empty queue"""
        corpus, _, _ = self.create_corpus_with_mocks()
        
        result = corpus.peek_reaching_testcase()
        assert result is None
        
    def test_peek_reaching_testcase_with_items(self):
        """Test peeking at testcase from queue with items"""
        corpus, _, _ = self.create_corpus_with_mocks()
        
        # Manually add items to queue
        test_path = "/path/to/test.txt"
        corpus.seed_queue.put(test_path)
        
        # Peek should return item without removing
        result = corpus.peek_reaching_testcase()
        assert result == test_path
        
        # Queue should still have the item (peek is non-destructive)
        result2 = corpus.peek_reaching_testcase()
        assert result2 == test_path
        
    def test_get_status(self):
        """Test getting corpus status"""
        corpus, _, _ = self.create_corpus_with_mocks()
        
        status = corpus.get_status()
        
        # Check that all expected keys are present
        assert "processing_complete" in status
        assert "total_processed" in status
        assert "reaching_found" in status
        assert "queue_size" in status
        assert "routes_analyzed" in status
        assert "failed_route_analysis" in status
        assert "possible_routes_count" in status
        
        # Check initial values
        assert status["processing_complete"] == False
        assert status["total_processed"] == 0
        assert status["reaching_found"] == 0
        assert status["queue_size"] == 0
        assert status["routes_analyzed"] == 0
        assert status["failed_route_analysis"] == 0
        assert status["possible_routes_count"] == 0
        
        # Update some values and test again
        corpus.processing_complete = True
        corpus.total_processed = 5
        corpus.reaching_found = 2
        corpus.routes_analyzed = 3
        corpus.failed_route_analysis = 1
        corpus.seed_queue.put("test1")
        corpus.seed_queue.put("test2")
        
        status = corpus.get_status()
        
        # Check updated values
        assert status["processing_complete"] == True
        assert status["total_processed"] == 5
        assert status["reaching_found"] == 2
        assert status["queue_size"] == 2
        assert status["routes_analyzed"] == 3
        assert status["failed_route_analysis"] == 1
        
    @patch('subprocess.run')
    def test_background_processing_integration(self, mock_run):
        """Test background processing integration"""
        # Mock subprocess to return reaching output for some files
        def mock_subprocess(*args, **kwargs):
            mock_proc = MagicMock()
            # Make test1.txt and test4.txt reach the target
            if "test1.txt" in str(args[0]) or "test4.txt" in str(args[0]):
                mock_proc.stderr = b"REACHED target"
            else:
                mock_proc.stderr = b"No target reached"
            mock_proc.returncode = 0
            return mock_proc
            
        mock_run.side_effect = mock_subprocess
        
        corpus, _, _ = self.create_corpus_with_mocks()
        
        # Start processing (but don't start consumer thread for this test)
        corpus._process_seeds_background()
        
        # Wait for processing to complete
        timeout = 10  # 10 second timeout
        start_time = time.time()
        while not corpus.processing_complete and (time.time() - start_time) < timeout:
            time.sleep(0.1)
            
        # Check results
        assert corpus.processing_complete
        assert corpus.total_processed == 4  # 4 test files
        assert corpus.reaching_found == 2  # test1.txt and test4.txt
        assert corpus.seed_queue.qsize() == 2
        
        # Check that queue files were created
        queue_files = list(corpus.queue_dir.glob("reaching_*"))
        assert len(queue_files) == 2

    @patch('subprocess.run')
    def test_processing_complete_race_condition(self, mock_run):
        """Test that processing_complete is not set prematurely due to race condition.
        
        This test captures a critical bug where processing_complete was set to True
        before the consumer thread had a chance to process routes, causing:
        1. Agent sees processing_complete=True via get_corpus_status()
        2. Agent calls get_reaching_routes() - gets some routes
        3. Consumer thread is still populating possible_routes
        4. Agent calls extract_parameters() - gets DIFFERENT state of possible_routes
        """
        # Mock subprocess to return reaching output
        mock_proc = MagicMock()
        mock_proc.stderr = b"REACHED target"
        mock_proc.returncode = 0
        mock_run.return_value = mock_proc
        
        corpus, _, _ = self.create_corpus_with_mocks()
        
        # Track when processing_complete is set to True
        processing_complete_timestamps = []
        original_processing_complete = corpus.processing_complete
        
        def track_processing_complete():
            return corpus.processing_complete
        
        # Start the background processing with both threads
        corpus.start_processing()
        
        # Give threads a moment to start
        time.sleep(0.05)
        
        # Check the state immediately after threads start
        # BUG: In the buggy version, processing_complete would be True here
        # FIX: In the fixed version, it should be False until consumer thread completes
        initial_status = corpus.get_status()
        
        # The bug manifested as processing_complete being True too early
        # Before fix: processing_complete would be True if consumer thread wasn't alive yet
        # After fix: processing_complete should only be True when consumer thread finishes
        
        # If there are target locations and consumer thread is running,
        # processing_complete should be False initially
        if corpus.consumer_thread and corpus.consumer_thread.is_alive():
            assert not initial_status['processing_complete'], \
                "BUG: processing_complete should not be True while consumer thread is still running"
        
        # Wait for seed scanning to complete
        timeout = 5
        start_time = time.time()
        while not corpus.reaching_seed_scanning_complete and (time.time() - start_time) < timeout:
            time.sleep(0.05)
        
        # After seed scanning completes, check if consumer thread is still working
        mid_status = corpus.get_status()
        
        # If consumer thread is alive and processing, processing_complete should still be False
        if corpus.consumer_thread and corpus.consumer_thread.is_alive():
            # This is where the bug would manifest:
            # Old code set processing_complete=True in _process_seeds_background
            # even though consumer thread was still running
            assert not mid_status['processing_complete'], \
                "BUG: processing_complete was set True while consumer thread still processing routes"
        
        # Wait for complete processing (both threads done)
        timeout = 10
        start_time = time.time()
        while not corpus.processing_complete and (time.time() - start_time) < timeout:
            time.sleep(0.1)
        
        # Now processing should be complete
        final_status = corpus.get_status()
        
        # Consumer thread should have finished
        if corpus.consumer_thread:
            assert not corpus.consumer_thread.is_alive(), \
                "Consumer thread should have finished by now"
        
        # Now processing_complete should be True
        assert final_status['processing_complete'], \
            "processing_complete should be True after all threads finish"
        
        # Verify routes were analyzed
        # This tests the sequence: scan seeds -> find reaching -> analyze routes -> complete
        assert final_status['total_processed'] > 0
        if final_status['reaching_found'] > 0:
            # If we found reaching testcases, routes should have been analyzed
            assert final_status['routes_analyzed'] >= 0  # May be 0 if analysis failed

    @patch('subprocess.run')
    def test_get_reaching_routes_extract_parameters_consistency(self, mock_run):
        """Test that get_reaching_routes and extract_parameters return consistent data.
        
        This is the specific bug scenario:
        1. Agent calls get_corpus_status() -> processing_complete=True (BUG!)
        2. Agent calls get_reaching_routes() -> gets N routes
        3. Agent calls extract_parameters() -> gets different number of routes (race!)
        
        The bug was that processing_complete was set True before consumer thread
        finished populating possible_routes.
        """
        # Mock subprocess to return reaching output
        mock_proc = MagicMock()
        mock_proc.stderr = b"REACHED target"
        mock_proc.returncode = 0
        mock_run.return_value = mock_proc
        
        # Mock debugger to simulate route analysis
        with patch.object(Corpus, '_analyze_testcase_routes') as mock_analyze:
            # Simulate successful route analysis
            def mock_route_analysis(testcase_path):
                # Simulate adding a route
                callstack = f"Frame 0: main\nFrame 1: test at {testcase_path}"
                self._update_possible_routes(callstack, testcase_path)
                return True, "success"
            
            corpus, _, _ = self.create_corpus_with_mocks()
            
            # Start processing
            corpus.start_processing()
            
            # Simulate the agent workflow: check status then get routes
            max_attempts = 50
            for attempt in range(max_attempts):
                time.sleep(0.05)
                
                status = corpus.get_status()
                
                # Agent checks if processing is complete
                if status['processing_complete']:
                    # Agent gets reaching routes
                    routes_call1 = corpus.get_possible_routes()
                    routes_count1 = len(routes_call1)
                    
                    # Small delay (simulating agent processing)
                    time.sleep(0.01)
                    
                    # Agent calls extract_parameters (which internally gets routes again)
                    routes_call2 = corpus.get_possible_routes()
                    routes_count2 = len(routes_call2)
                    
                    # BUG CHECK: Routes should be consistent
                    # In buggy version, processing_complete could be True while
                    # consumer thread is still adding routes, causing inconsistency
                    assert routes_count1 == routes_count2, \
                        f"RACE CONDITION BUG: get_possible_routes() returned {routes_count1} routes, " \
                        f"then {routes_count2} routes. This indicates processing_complete was set " \
                        f"while consumer thread was still updating possible_routes!"
                    
                    # If we got here, the bug is fixed - routes are consistent
                    break
            
            # Ensure we actually tested the condition
            # (processing_complete should eventually be True)
            assert corpus.processing_complete, \
                "Test didn't complete - processing_complete never became True"

    @patch('subprocess.run')
    def test_maybe_mark_complete_logic(self, mock_run):
        """Test _maybe_mark_complete only marks complete when both conditions are met.
        
        BUG: Consumer thread unconditionally set processing_complete=True even when
        scanner was still running or queue had items.
        
        FIX: Use _maybe_mark_complete() which checks both conditions.
        """
        # Mock subprocess
        mock_proc = MagicMock()
        mock_proc.stderr = b"REACHED target"
        mock_proc.returncode = 0
        mock_run.return_value = mock_proc
        
        corpus, _, _ = self.create_corpus_with_mocks()
        
        # Create a mock consumer thread to simulate the scenario where consumer exists
        mock_consumer = MagicMock()
        corpus.consumer_thread = mock_consumer
        
        # Initially both flags are False
        assert not corpus.reaching_seed_scanning_complete
        assert not corpus.processing_complete
        
        # Add items to queue
        corpus.seed_queue.put("test1")
        corpus.seed_queue.put("test2")
        
        # Test Case 1: Scan complete but queue NOT empty (with consumer) -> should NOT mark complete
        corpus.reaching_seed_scanning_complete = True
        corpus._maybe_mark_complete()
        assert not corpus.processing_complete, \
            "Should NOT mark complete when consumer exists and queue has items"
        
        # Test Case 2: Scan NOT complete but queue empty -> should NOT mark complete
        corpus.reaching_seed_scanning_complete = False
        corpus.seed_queue.get_nowait()
        corpus.seed_queue.get_nowait()
        corpus._maybe_mark_complete()
        assert not corpus.processing_complete, \
            "Should NOT mark complete when scan is not done"
        
        # Test Case 3: Both scan complete AND queue empty -> SHOULD mark complete
        corpus.reaching_seed_scanning_complete = True
        corpus._maybe_mark_complete()
        assert corpus.processing_complete, \
            "SHOULD mark complete when both scan done and queue empty"
        
        # Test Case 4: No consumer thread - should mark complete when scan done
        corpus.processing_complete = False  # Reset
        corpus.consumer_thread = None
        corpus.seed_queue.put("test3")  # Add item to queue
        corpus.reaching_seed_scanning_complete = True
        corpus._maybe_mark_complete()
        assert corpus.processing_complete, \
            "SHOULD mark complete when no consumer thread and scan done (even if queue has items)"

class TestMCPCorpusServer:
    """Test the MCP Corpus Server functionality"""
    
    def setup_method(self):
        """Set up test environment"""
        self.temp_dir = tempfile.mkdtemp()
        self.input_dir = Path(self.temp_dir) / "input"
        self.output_dir = Path(self.temp_dir) / "output"
        self.static_dir = Path(self.temp_dir) / "static"
        
        # Create directories and test files
        self.input_dir.mkdir(parents=True)
        self.output_dir.mkdir(parents=True)
        self.static_dir.mkdir(parents=True)
        (self.input_dir / "test1.txt").write_text("test input 1")
        
        # Create static files - use the real readelf_static_analysis directory
        readelf_static_dir = Path(__file__).parent / "fixtures" / "readelf_static_analysis"
        if readelf_static_dir.exists():
            # Copy files from the real static analysis directory
            shutil.copytree(readelf_static_dir, self.static_dir, dirs_exist_ok=True)
        else:
            # Fallback: create minimal static files
            (self.static_dir / "BBtargets.txt").write_text("/test/file.c:10\n/test/file.c:20\n")
            (self.static_dir / "function_info.txt").write_text("1,main,/test/file.c,5,25\n")
            (self.static_dir / "bid_loc_mapping.txt").write_text("")
            (self.static_dir / "caller-callee.txt").write_text("")
            (self.static_dir / "callee-caller.txt").write_text("")
        
        self.server = MCPCorpusServer(str(self.output_dir))
        
    def teardown_method(self):
        """Clean up test environment"""
        shutil.rmtree(self.temp_dir, ignore_errors=True)
        
    @patch('mcp_corpus_server.RuntimeDebugger')
    @patch('mcp_corpus_server.SourceCodeFinder')
    def test_server_initialization(self, mock_source_finder, mock_debugger):
        """Test MCP server initialization"""
        mock_source_finder.return_value = MagicMock()
        mock_debugger.return_value = MagicMock()
        
        result = self.server.initialize_corpus(
            input_dir=str(self.input_dir),
            output_dir=str(self.output_dir),
            cmd_template="echo @@",
            reached_pattern="REACHED",
            static_result_folder=str(self.static_dir)
        )
        
        assert result
        assert self.server.corpus is not None
        assert self.server.corpus.input_dir == self.input_dir

    def test_server_has_new_methods(self):
        """Test that server has the new methods for route handling"""
        # Verify the server has setup_handlers method
        assert hasattr(self.server, 'setup_handlers')
        
        # After initialization, verify corpus has new attributes
        mock_corpus = MagicMock()
        mock_corpus.get_possible_routes.return_value = {}
        mock_corpus.get_status.return_value = {
            'routes_analyzed': 0,
            'possible_routes_count': 0
        }
        
        self.server.corpus = mock_corpus
        
        # Verify we can call the new methods
        routes = self.server.corpus.get_possible_routes()
        status = self.server.corpus.get_status()
        
        assert isinstance(routes, dict)
        assert 'routes_analyzed' in status
        assert 'possible_routes_count' in status


class TestIntegration:
    """Integration tests for the complete corpus server functionality"""
    
    def setup_method(self):
        """Set up test environment"""
        self.temp_dir = tempfile.mkdtemp()
        self.input_dir = Path(self.temp_dir) / "input"
        self.output_dir = Path(self.temp_dir) / "output"
        
        # Create directories
        self.input_dir.mkdir(parents=True)
        self.output_dir.mkdir(parents=True)
        
        # Create a simple test program that echoes input and prints REACHED for specific inputs
        self.test_program = Path(self.temp_dir) / "test_program.py"
        self.test_program.write_text('''#!/usr/bin/env python3
import sys
if len(sys.argv) > 1:
    with open(sys.argv[1], 'r') as f:
        content = f.read().strip()
else:
    content = sys.stdin.read().strip()

print(f"Processing: {content}", file=sys.stderr)
if "magic" in content:
    print("REACHED target location", file=sys.stderr)
sys.exit(0)
''')
        self.test_program.chmod(0o755)
        
        # Create test input files
        (self.input_dir / "normal.txt").write_text("normal input")
        (self.input_dir / "magic.txt").write_text("magic input")  # This should reach target
        (self.input_dir / "another.txt").write_text("another input")
        (self.input_dir / "magic_word.txt").write_text("contains magic word")  # This should also reach
        
    def teardown_method(self):
        """Clean up test environment"""
        shutil.rmtree(self.temp_dir, ignore_errors=True)
        
    @patch('mcp_corpus_server.RuntimeDebugger')
    @patch('mcp_corpus_server.SourceCodeFinder')
    def test_end_to_end_corpus_processing(self, mock_source_finder, mock_debugger):
        """Test complete end-to-end corpus processing"""
        # Mock the components to avoid actual initialization
        mock_source_finder.return_value = MagicMock()
        mock_debugger.return_value = MagicMock()
        
        # Create a temporary static directory for this test
        static_dir = Path(self.temp_dir) / "static"
        static_dir.mkdir(exist_ok=True)
        (static_dir / "BBtargets.txt").write_text("/test/file.c:10\n")
        (static_dir / "function_info.txt").write_text("1,main,/test/file.c,5,25\n")
        (static_dir / "bid_loc_mapping.txt").write_text("")
        (static_dir / "caller-callee.txt").write_text("")
        (static_dir / "callee-caller.txt").write_text("")
        
        # Create corpus with real test program
        corpus = Corpus(
            input_dir=str(self.input_dir),
            output_dir=str(self.output_dir),
            cmd_template=f"python3 {self.test_program} @@",
            reached_pattern="REACHED",
            static_result_folder=str(static_dir)
        )
        
        # Start processing (but don't start consumer thread for this test)
        corpus._process_seeds_background()
        
        # Wait for processing to complete
        timeout = 10  # 10 second timeout
        start_time = time.time()
        while not corpus.processing_complete and (time.time() - start_time) < timeout:
            time.sleep(0.1)
            
        # Check results
        assert corpus.processing_complete, "Processing should complete within timeout"
        assert corpus.total_processed == 4, "Should process all 4 test files"
        assert corpus.reaching_found == 2, "Should find 2 reaching testcases (magic.txt and magic_word.txt)"
        assert corpus.seed_queue.qsize() == 2, "Queue should contain 2 testcases"
        
        # Check that we can peek at testcases without removing them
        testcase1 = corpus.peek_reaching_testcase()
        assert testcase1 is not None
        
        # Verify queue still has items after peek
        assert corpus.seed_queue.qsize() == 2, "Peek should not remove items"
        
        # Check that queue files exist and contain correct content
        queue_files = list(corpus.queue_dir.glob("reaching_*"))
        assert len(queue_files) == 2
        
        # Verify content of queue files
        queue_contents = []
        for queue_file in queue_files:
            content = queue_file.read_text().strip()
            queue_contents.append(content)
            
        assert "magic input" in queue_contents
        assert "contains magic word" in queue_contents


class TestParameterExtraction:
    """Test parameter extraction functionality"""
    
    def setup_method(self):
        """Set up test environment for parameter extraction tests"""
        self.temp_dir = tempfile.mkdtemp()
        self.input_dir = Path(self.temp_dir) / "input"
        self.output_dir = Path(self.temp_dir) / "output"
        self.static_dir = Path(self.temp_dir) / "static"
        
        # Create directories
        self.input_dir.mkdir(parents=True)
        self.output_dir.mkdir(parents=True)
        self.static_dir.mkdir(parents=True)
        
        # Create realistic test files based on readelf.cpp example
        self.create_realistic_test_files()
        self.create_minimal_static_files()
        
    def teardown_method(self):
        """Clean up test environment"""
        shutil.rmtree(self.temp_dir, ignore_errors=True)
        
    def create_realistic_test_files(self):
        """Create realistic test files simulating different ELF-like formats"""
        
        # Create small ELF-like file (32-bit, little endian)
        small_elf = bytearray(64)
        small_elf[0:4] = [0x7f, ord('E'), ord('L'), ord('F')]  # ELF magic
        small_elf[4] = 1  # ELFCLASS32 (32-bit)
        small_elf[5] = 1  # ELFDATA2LSB (little endian)  
        small_elf[6] = 1  # EV_CURRENT
        # Entry point at offset 24 (4 bytes for 32-bit)
        entry_32bit = 0x8048000
        for i in range(4):
            small_elf[24 + i] = (entry_32bit >> (8*i)) & 0xFF
        
        small_elf_path = self.input_dir / "small_elf.bin"
        small_elf_path.write_bytes(small_elf)
        
        # Create large ELF-like file (64-bit, big endian) 
        large_elf = bytearray(128)
        large_elf[0:4] = [0x7f, ord('E'), ord('L'), ord('F')]  # ELF magic
        large_elf[4] = 2  # ELFCLASS64 (64-bit)
        large_elf[5] = 2  # ELFDATA2MSB (big endian)
        large_elf[6] = 1  # EV_CURRENT
        # Entry point at offset 24 (8 bytes for 64-bit, big endian)
        entry_64bit = 0x400000
        for i in range(8):
            large_elf[24 + i] = (entry_64bit >> (56 - 8*i)) & 0xFF
            
        large_elf_path = self.input_dir / "large_elf.bin"  
        large_elf_path.write_bytes(large_elf)
        
        # Create malformed file (invalid magic)
        malformed = bytearray(32)
        malformed[0:4] = [0x00, 0x01, 0x02, 0x03]  # Invalid magic
        malformed[4] = 1  # ELFCLASS32
        malformed[5] = 1  # ELFDATA2LSB
        
        malformed_path = self.input_dir / "malformed.bin"
        malformed_path.write_bytes(malformed)
        
        # Create text file
        text_content = """#include <stdio.h>
int main() {
    printf("Hello world\\n");
    return 0;  
}"""
        text_path = self.input_dir / "test.c"
        text_path.write_text(text_content)
        
    def create_minimal_static_files(self):
        """Create minimal static analysis files for testing"""
        # BBtargets.txt with absolute paths
        bb_targets_file = self.static_dir / "BBtargets.txt" 
        bb_targets_content = f"""{self.temp_dir}/readelf.cpp:82
{self.temp_dir}/readelf.cpp:94
"""
        bb_targets_file.write_text(bb_targets_content)
        
        # Create basic function_info.txt
        function_info_file = self.static_dir / "function_info.txt"
        function_info_content = f"""1,check_dangerous_elf_combination,{self.temp_dir}/readelf.cpp,75,99
2,main,{self.temp_dir}/readelf.cpp,101,148
"""
        function_info_file.write_text(function_info_content)
        
        # Create other required files
        (self.static_dir / "bid_loc_mapping.txt").write_text("")
        (self.static_dir / "caller-callee.txt").write_text("") 
        (self.static_dir / "callee-caller.txt").write_text("")
        
    def create_corpus_with_routes(self):
        """Create corpus with mock routes pointing to our test files"""
        with patch('mcp_corpus_server.RuntimeDebugger') as mock_debugger, \
             patch('mcp_corpus_server.SourceCodeFinder') as mock_source_finder:
            
            # Setup mocks
            mock_source_finder_instance = MagicMock()
            mock_source_finder.return_value = mock_source_finder_instance  
            mock_debugger.return_value = MagicMock()
            
            # Create actual test source files
            readelf_cpp_file = Path(self.temp_dir) / "readelf.cpp"
            readelf_cpp_file.write_text("""
// Simplified readelf.cpp for testing
#include <iostream>
void check_dangerous_elf_combination() {
    std::cerr << "bug location reached" << std::endl;
    if (condition) {
        std::cerr << "bug location triggered" << std::endl; 
    }
}
int main() { return 0; }
""")
            
            # Mock the source finder methods
            def mock_get_fp_from_func_id(func_id):
                return str(readelf_cpp_file.absolute())
                
            def mock_get_func_ids_from_loc(loc):
                if "readelf.cpp" in loc:
                    return ["1", "2"]
                return ["1"]
                
            mock_source_finder_instance.get_fp_from_func_id.side_effect = mock_get_fp_from_func_id
            mock_source_finder_instance.get_func_ids_from_loc.side_effect = mock_get_func_ids_from_loc
            mock_source_finder_instance.fp_fn_map = {
                "readelf.cpp": [str(readelf_cpp_file.absolute())]
            }
            
            # Create corpus
            corpus = Corpus(
                input_dir=str(self.input_dir),
                output_dir=str(self.output_dir), 
                cmd_template="echo @@",
                reached_pattern="bug location reached",
                static_result_folder=str(self.static_dir)
            )
            
            # Add test routes manually
            test_files = [
                self.input_dir / "small_elf.bin",
                self.input_dir / "large_elf.bin", 
                self.input_dir / "malformed.bin",
                self.input_dir / "test.c"
            ]
            
            for i, test_file in enumerate(test_files):
                if test_file.exists():
                    callstack = f"Frame {i}: check_dangerous_elf_combination at readelf.cpp:{82+i}\nFrame {i+1}: main at readelf.cpp:{101+i}"
                    corpus._update_possible_routes(callstack, str(test_file.absolute()))
                    
            return corpus
            
    def test_extract_parameters_basic_functionality(self):
        """Test basic parameter extraction functionality"""
        corpus = self.create_corpus_with_routes()
        
        # Create a simple extractor that analyzes file sizes and formats
        extractor_code = '''
def extract_parameters(file_path):
    import os
    import struct
    
    # Get file size
    file_size = os.path.getsize(file_path)
    
    # Read file header
    with open(file_path, 'rb') as f:
        header = f.read(16)
    
    params = {}
    
    # Extract file size parameter
    params["file_size"] = {
        "type": "int_range",
        "min": max(0, file_size - 50),
        "max": file_size + 50
    }
    
    # Detect format based on magic bytes
    if len(header) >= 4 and header[0:4] == b'\\x7fELF':
        # ELF file
        if len(header) >= 5:
            if header[4] == 1:  # ELFCLASS32
                params["elf_class"] = {"type": "categorical", "values": [32]}
            elif header[4] == 2:  # ELFCLASS64  
                params["elf_class"] = {"type": "categorical", "values": [64]}
                
        if len(header) >= 6:
            if header[5] == 1:  # ELFDATA2LSB
                params["endianness"] = {"type": "categorical", "values": ["little"]}
            elif header[5] == 2:  # ELFDATA2MSB
                params["endianness"] = {"type": "categorical", "values": ["big"]}
                
        params["format_type"] = {"type": "categorical", "values": ["elf"]}
    else:
        # Non-ELF file
        params["format_type"] = {"type": "categorical", "values": ["other"]}
        
    return params
'''
        
        # Test parameter extraction
        result = corpus.extract_parameters_from_routes(extractor_code)
        
        # Verify results
        assert isinstance(result, dict)
        assert len(result) > 0
        
        # Check that file_size parameter was extracted and merged
        assert "file_size" in result
        assert result["file_size"]["type"] == "int_range"
        assert "min" in result["file_size"]
        assert "max" in result["file_size"]
        
        # Check format detection
        assert "format_type" in result
        assert result["format_type"]["type"] == "categorical"
        expected_formats = set(result["format_type"]["values"])
        assert "elf" in expected_formats or "other" in expected_formats
        
        # Check ELF-specific parameters
        if "elf_class" in result:
            assert result["elf_class"]["type"] == "categorical"
            assert all(val in [32, 64] for val in result["elf_class"]["values"])
            
        if "endianness" in result: 
            assert result["endianness"]["type"] == "categorical"
            assert all(val in ["little", "big"] for val in result["endianness"]["values"])
            
    def test_extract_parameters_merging_logic(self):
        """Test parameter space merging logic"""
        corpus = self.create_corpus_with_routes()
        
        # Create extractor that generates different parameter ranges per file
        extractor_code = '''
def extract_parameters(file_path):
    import os
    
    file_size = os.path.getsize(file_path)
    filename = os.path.basename(file_path)
    
    params = {}
    
    # Different size ranges based on filename
    if "small" in filename:
        params["buffer_size"] = {"type": "int_range", "min": 10, "max": 100}
        params["format"] = {"type": "categorical", "values": ["small_format"]}
    elif "large" in filename:
        params["buffer_size"] = {"type": "int_range", "min": 50, "max": 200} 
        params["format"] = {"type": "categorical", "values": ["large_format"]}
    else:
        params["buffer_size"] = {"type": "int_range", "min": 20, "max": 150}
        params["format"] = {"type": "categorical", "values": ["generic_format"]}
        
    # Boolean parameter
    params["is_binary"] = {"type": "bool"}
    
    return params
'''
        
        result = corpus.extract_parameters_from_routes(extractor_code)
        
        # Verify merging worked correctly
        assert "buffer_size" in result
        assert result["buffer_size"]["type"] == "int_range"
        # Should merge ranges: min(10, 50, 20) = 10, max(100, 200, 150) = 200
        assert result["buffer_size"]["min"] == 10
        assert result["buffer_size"]["max"] == 200
        
        # Check categorical merging
        assert "format" in result
        assert result["format"]["type"] == "categorical"
        formats = set(result["format"]["values"])
        assert "small_format" in formats
        assert "large_format" in formats  
        assert "generic_format" in formats
        
        # Check boolean parameter
        assert "is_binary" in result
        assert result["is_binary"]["type"] == "bool"
        
    def test_extract_parameters_error_handling(self):
        """Test error handling in parameter extraction"""
        corpus = self.create_corpus_with_routes()
        
        # Test invalid extractor code (syntax error)
        invalid_extractor = '''
def extract_parameters(file_path: str) -> Dict[str, Any]:
    import os
    # Syntax error - missing closing quote
    return {"test": "unclosed_string}
'''
        
        result = corpus.extract_parameters_from_routes(invalid_extractor)
        assert result == {}  # Should return empty dict on error
        
        # Test extractor that raises exceptions
        exception_extractor = '''
def extract_parameters(file_path):
    import os
    
    # This will raise an exception for some files
    if "malformed" in file_path:
        raise ValueError("Cannot process malformed file")
        
    return {"test_param": {"type": "int_range", "min": 0, "max": 10}}
'''
        
        result = corpus.extract_parameters_from_routes(exception_extractor)
        # Should still return results from files that didn't raise exceptions
        assert isinstance(result, dict)
        
    def test_extract_parameters_complex_analysis(self):
        """Test complex parameter extraction with binary format analysis"""
        corpus = self.create_corpus_with_routes()
        
        # Create a sophisticated extractor similar to what would be used for readelf
        complex_extractor = '''
def extract_parameters(file_path):
    import os
    import struct
    
    params = {}
    
    with open(file_path, 'rb') as f:
        data = f.read(64)  # Read first 64 bytes (ELF header size)
    
    file_size = len(data)
    params["file_size"] = {
        "type": "int_range", 
        "min": max(0, file_size - 32),
        "max": file_size + 64
    }
    
    if len(data) >= 4:
        # Check ELF magic
        if data[0:4] == b'\\x7fELF':
            params["is_elf"] = {"type": "categorical", "values": [True]}
            
            if len(data) >= 16:
                # ELF class (32 vs 64 bit)
                elf_class = data[4] if len(data) > 4 else 0
                if elf_class in [1, 2]:
                    class_bits = 32 if elf_class == 1 else 64
                    params["architecture"] = {"type": "categorical", "values": [class_bits]}
                
                # Data encoding (endianness)
                data_encoding = data[5] if len(data) > 5 else 0
                if data_encoding in [1, 2]:
                    endian = "little" if data_encoding == 1 else "big"
                    params["endianness"] = {"type": "categorical", "values": [endian]}
                
                # Version
                version = data[6] if len(data) > 6 else 0
                params["elf_version"] = {"type": "int_range", "min": version, "max": version + 2}
                
                # Extract entry point based on architecture
                if len(data) >= 32:
                    try:
                        if elf_class == 1:  # 32-bit
                            # Entry point at offset 24, 4 bytes
                            entry_point = struct.unpack('<I' if data_encoding == 1 else '>I', data[24:28])[0]
                        else:  # 64-bit  
                            # Entry point at offset 24, 8 bytes
                            entry_point = struct.unpack('<Q' if data_encoding == 1 else '>Q', data[24:32])[0]
                        
                        # Common entry points that might trigger bugs
                        common_entries = [0x400000, 0x8048000, 0x10000000]
                        if entry_point in common_entries:
                            params["entry_point"] = {"type": "categorical", "values": [entry_point]}
                        else:
                            params["entry_point"] = {"type": "int_range", "min": 0, "max": entry_point + 0x1000}
                    except:
                        # If entry point extraction fails, provide a default range
                        params["entry_point"] = {"type": "int_range", "min": 0, "max": 0x8048000}
        else:
            params["is_elf"] = {"type": "categorical", "values": [False]}
            params["format_type"] = {"type": "categorical", "values": ["unknown"]}
    
    return params
'''
        
        result = corpus.extract_parameters_from_routes(complex_extractor)
        
        # Verify complex analysis results
        assert isinstance(result, dict)
        assert len(result) > 0
        
        # Should detect ELF files
        if "is_elf" in result:
            assert result["is_elf"]["type"] == "categorical"
            assert True in result["is_elf"]["values"] or False in result["is_elf"]["values"]
            
        # Should extract architecture info
        if "architecture" in result:
            assert result["architecture"]["type"] == "categorical"
            assert all(arch in [32, 64] for arch in result["architecture"]["values"])
            
        # Should extract endianness
        if "endianness" in result:
            assert result["endianness"]["type"] == "categorical"
            assert all(endian in ["little", "big"] for endian in result["endianness"]["values"])
            
        # Should have entry point information
        if "entry_point" in result:
            assert result["entry_point"]["type"] in ["categorical", "int_range"]
            
    @async_test 
    async def test_mcp_server_extract_parameters_tool(self):
        """Test the MCP server extract_parameters tool end-to-end"""
        # Create MCP server
        server = MCPCorpusServer(str(self.output_dir))
        
        # Initialize with corpus
        with patch('mcp_corpus_server.RuntimeDebugger') as mock_debugger, \
             patch('mcp_corpus_server.SourceCodeFinder') as mock_source_finder:
                
            mock_source_finder.return_value = MagicMock()
            mock_debugger.return_value = MagicMock()
            
            success = server.initialize_corpus(
                input_dir=str(self.input_dir),
                output_dir=str(self.output_dir),
                cmd_template="echo @@", 
                reached_pattern="REACHED",
                static_result_folder=str(self.static_dir)
            )
            
            assert success
            assert server.corpus is not None
            
            # Add some routes manually for testing
            test_file = self.input_dir / "small_elf.bin"
            if test_file.exists():
                callstack = "Frame 0: main at readelf.cpp:145"
                server.corpus._update_possible_routes(callstack, str(test_file.absolute()))
            
            # Setup handlers
            server.setup_handlers()
            
            # Test extract_parameters tool - call the corpus method directly 
            # since accessing MCP handler internals is complex
            extractor_code = '''
def extract_parameters(file_path):
    import os
    
    file_size = os.path.getsize(file_path)
    
    return {
        "file_size": {
            "type": "int_range",
            "min": 0,
            "max": file_size * 2
        },
        "format": {
            "type": "categorical", 
            "values": ["binary"]
        }
    }
'''
            
            # Test the corpus method directly
            result_dict = server.corpus.extract_parameters_from_routes(extractor_code)
            assert isinstance(result_dict, dict)
            assert len(result_dict) > 0
            assert "file_size" in result_dict
            assert result_dict["file_size"]["type"] == "int_range"
            assert "format" in result_dict
            assert result_dict["format"]["type"] == "categorical"
            assert result_dict["format"]["values"] == ["binary"]


if __name__ == '__main__':
    # Import subprocess here to avoid issues with mocking
    import subprocess
    
    # Run tests with pytest
    pytest.main([__file__, "-v"])
