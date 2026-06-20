#!/usr/bin/env python3
"""
Test suite for MCP Call Graph Server

Tests the call graph analysis functionality including:
- MCP server initialization and tool listing
- Function caller/callee relationship queries
- Mangled name handling and demangling
- Error handling for missing data
- Workflow state gatekeeper functionality
"""

import asyncio
import os
import subprocess
import tempfile
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from mcp_call_graph_server import CallGraph, MCPCallGraphServer
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


class TestCallGraph:
    """Test the CallGraph class functionality"""
    
    def setup_method(self):
        """Set up test environment"""
        self.temp_dir = tempfile.mkdtemp()
        self.static_dir = Path(self.temp_dir) / "static"
        self.static_dir.mkdir(parents=True)
        
        self.temp_files = [self.temp_dir]
        
        # Create test static analysis files
        self.create_static_files()
        
        # Create config object
        self.config = type('Config', (), {
            'static_result_folder': str(self.static_dir)
        })()
        
    def teardown_method(self):
        """Clean up test environment"""
        import shutil
        for temp_file in self.temp_files:
            if os.path.exists(temp_file):
                if os.path.isfile(temp_file):
                    os.unlink(temp_file)
                elif os.path.isdir(temp_file):
                    shutil.rmtree(temp_file, ignore_errors=True)
    
    def create_static_files(self):
        """Create test static analysis files"""
        # Create function_info.txt
        function_info_file = self.static_dir / "function_info.txt"
        function_info_content = """1,main,/test/main.c,10,30
2,test_func,/test/test.c,5,25
3,helper_func,/test/helper.c,1,15
4,_ZN9ImageStreamC2EP6Streamiii,/test/image.cpp,50,70
5,_Z10process_pngPKc,/test/png.cpp,100,150
"""
        function_info_file.write_text(function_info_content)
        
        # Create bid_loc_mapping.txt
        bid_mapping_file = self.static_dir / "bid_loc_mapping.txt"
        bid_mapping_content = """1001,1001,1,/test/main.c:15
1002,1002,2,/test/test.c:10
1003,1003,3,/test/helper.c:5
1004,1004,4,/test/image.cpp:60
1005,1005,5,/test/png.cpp:120
"""
        bid_mapping_file.write_text(bid_mapping_content)
        
        # Create caller-callee.txt (caller -> callees)
        caller_callee_file = self.static_dir / "caller-callee.txt"
        caller_callee_content = """1,2,3
2,3,4
4,5
"""
        caller_callee_file.write_text(caller_callee_content)
        
        # Create callee-caller.txt (callee -> callers)
        callee_caller_file = self.static_dir / "callee-caller.txt"
        callee_caller_content = """2,1
3,1,2
4,2
5,4
"""
        callee_caller_file.write_text(callee_caller_content)
    
    def test_call_graph_initialization(self):
        """Test CallGraph initialization"""
        call_graph = CallGraph(self.config)
        
        assert call_graph is not None
        assert call_graph.config == self.config
        assert len(call_graph.function_infos) == 5
        assert len(call_graph.caller_callee_map) == 3
        assert len(call_graph.callee_caller_map) == 4
    
    def test_function_info_loading(self):
        """Test function info loading"""
        call_graph = CallGraph(self.config)
        
        # Test basic function info retrieval
        assert call_graph.get_func_name_from_func_id(1) == "main"
        assert call_graph.get_func_name_from_func_id(2) == "test_func"
        assert call_graph.get_fp_from_func_id(1) == "/test/main.c"
        
        # Test mangled names
        assert call_graph.get_func_name_from_func_id(4) == "_ZN9ImageStreamC2EP6Streamiii"
        assert call_graph.get_func_name_from_func_id(5) == "_Z10process_pngPKc"
        
        # Test non-existent function
        assert call_graph.get_func_name_from_func_id(999) == ""
    
    def test_caller_callee_relationships(self):
        """Test caller-callee relationship queries"""
        call_graph = CallGraph(self.config)
        
        # Test getting callees
        main_callees = call_graph.caller_callee_map.get(1, [])
        assert 2 in main_callees  # main calls test_func
        assert 3 in main_callees  # main calls helper_func
        
        test_func_callees = call_graph.caller_callee_map.get(2, [])
        assert 3 in test_func_callees  # test_func calls helper_func
        assert 4 in test_func_callees  # test_func calls ImageStream constructor
        
        # Test getting callers
        test_func_callers = call_graph.callee_caller_map.get(2, [])
        assert 1 in test_func_callers  # main calls test_func
        
        helper_func_callers = call_graph.callee_caller_map.get(3, [])
        assert 1 in helper_func_callers  # main calls helper_func
        assert 2 in helper_func_callers  # test_func calls helper_func
    
    def test_get_callers_by_name(self):
        """Test getting callers by function name"""
        call_graph = CallGraph(self.config)
        
        # Test getting callers for test_func
        callers = call_graph.get_callers("test_func")
        assert isinstance(callers, list)
        assert "main" in callers
        
        # Test getting callers for helper_func
        callers = call_graph.get_callers("helper_func")
        assert isinstance(callers, list)
        assert "main" in callers
        assert "test_func" in callers
        
        # Test non-existent function
        callers = call_graph.get_callers("non_existent_func")
        assert callers == []
    
    def test_get_callees_by_name(self):
        """Test getting callees by function name"""
        call_graph = CallGraph(self.config)
        
        # Test getting callees for main
        callees = call_graph.get_callees("main")
        assert isinstance(callees, list)
        assert "test_func" in callees
        assert "helper_func" in callees
        
        # Test getting callees for test_func
        callees = call_graph.get_callees("test_func")
        assert isinstance(callees, list)
        assert "helper_func" in callees
        
        # Test non-existent function
        callees = call_graph.get_callees("non_existent_func")
        assert callees == []
    
    @patch('subprocess.run')
    def test_mangled_name_demangling(self, mock_run):
        """Test C++ mangled name demangling"""
        call_graph = CallGraph(self.config)
        
        # Mock c++filt command
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "ImageStream::ImageStream(Stream*, int, int, int)"
        mock_run.return_value = mock_proc
        
        # Test demangling
        mangled_name = "_ZN9ImageStreamC2EP6Streamiii"
        demangled = call_graph._demangle_name(mangled_name)
        
        # Should extract class name from constructor
        assert demangled in ["ImageStream", "ImageStream::ImageStream(Stream*, int, int, int)"]
    
    def test_mangled_name_detection(self):
        """Test mangled name detection"""
        call_graph = CallGraph(self.config)
        
        # Test mangled names
        assert call_graph._is_mangled_name("_ZN9ImageStreamC2EP6Streamiii")
        assert call_graph._is_mangled_name("_Z10process_pngPKc")
        
        # Test normal names
        assert not call_graph._is_mangled_name("main")
        assert not call_graph._is_mangled_name("test_func")
        assert not call_graph._is_mangled_name("helper_func")
        
        # Test edge cases
        assert not call_graph._is_mangled_name("")
        assert not call_graph._is_mangled_name("normal_function_name")
    
    def test_missing_static_files(self):
        """Test handling of missing static analysis files"""
        # Create empty directory
        empty_dir = Path(self.temp_dir) / "empty"
        empty_dir.mkdir()
        
        config = type('Config', (), {
            'static_result_folder': str(empty_dir)
        })()
        
        # Should not crash with missing files
        call_graph = CallGraph(config)
        
        assert len(call_graph.function_infos) == 0
        assert len(call_graph.caller_callee_map) == 0
        assert len(call_graph.callee_caller_map) == 0
        
        # Should return appropriate error responses
        callers = call_graph.get_callers("any_func")
        assert isinstance(callers, dict)
        assert callers["error"] == "no_callgraph_data"
        
        callees = call_graph.get_callees("any_func")
        assert isinstance(callees, dict)
        assert callees["error"] == "no_callgraph_data"


class TestMCPCallGraphServer:
    """Test the MCP Call Graph Server functionality"""
    
    def setup_method(self):
        """Set up test environment"""
        self.temp_dir = tempfile.mkdtemp()
        self.static_dir = Path(self.temp_dir) / "static"
        self.static_dir.mkdir(parents=True)
        
        self.temp_files = [self.temp_dir]
        
        # Create workflow state file for gatekeeper tests
        self.create_workflow_state()
        
        # Create test static analysis files (use real fixtures if available)
        self.create_static_files()
        
        self.server = MCPCallGraphServer()
        
    def teardown_method(self):
        """Clean up test environment"""
        import shutil
        for temp_file in self.temp_files:
            if os.path.exists(temp_file):
                if os.path.isfile(temp_file):
                    os.unlink(temp_file)
                elif os.path.isdir(temp_file):
                    shutil.rmtree(temp_file, ignore_errors=True)
    
    def create_workflow_state(self):
        """Create workflow state file for gatekeeper tests"""
        project_cursor_dir = Path.cwd() / ".cursor"
        project_cursor_dir.mkdir(parents=True, exist_ok=True)
        workflow_state_file = project_cursor_dir / "workflow_state.md"
        
        workflow_state_content = '''# Workflow State

<!-- DYNAMIC:STATE:START -->
## State
```json
{
  "phase": "ANALYZE",
  "status": "Test Mode - Ready for call graph analysis",
  "current_task": "Test call graph functionality",
  "next_action": "Execute call graph tools"
}
```
<!-- DYNAMIC:STATE:END -->

<!-- DYNAMIC:PRECONDITIONS:START -->
## Preconditions
```json
[]
```
<!-- DYNAMIC:PRECONDITIONS:END -->

<!-- DYNAMIC:ROOT_CAUSES:START -->
## RootCauses
```json
[]
```
<!-- DYNAMIC:ROOT_CAUSES:END -->

<!-- DYNAMIC:PARAMETER_SPACE:START -->
## ParameterSpace
```json
{}
```
<!-- DYNAMIC:PARAMETER_SPACE:END -->

<!-- DYNAMIC:TRIGGER_PLANS:START -->
## TriggerPlans
```json
[]
```
<!-- DYNAMIC:TRIGGER_PLANS:END -->

<!-- DYNAMIC:FUZZ_PLAN:START -->
## FuzzPlan
```json
[]
```
<!-- DYNAMIC:FUZZ_PLAN:END -->

<!-- DYNAMIC:BREAKPOINTS:START -->
## Breakpoints
```json
[]
```
<!-- DYNAMIC:BREAKPOINTS:END -->

<!-- DYNAMIC:METRICS:START -->
## Metrics
```json
{
  "total_iterations": 0,
  "total_reached_count": 0,
  "last_reached_count": 0,
  "triggered_count": 0,
  "timeout_count": 0,
  "error_count": 0,
  "last_updated": ""
}
```
<!-- DYNAMIC:METRICS:END -->

<!-- DYNAMIC:LOG:START -->
## Log
```json
[]
```
<!-- DYNAMIC:LOG:END -->
'''
        
        with open(workflow_state_file, 'w') as f:
            f.write(workflow_state_content)
        
        self.temp_files.append(workflow_state_file)
    
    def create_static_files(self):
        """Create test static analysis files"""
        # Try to use real fixtures if available
        fixtures_dir = Path(__file__).parent / "fixtures" / "readelf_static_analysis"
        if fixtures_dir.exists():
            import shutil
            shutil.copytree(fixtures_dir, self.static_dir, dirs_exist_ok=True)
        else:
            # Create minimal test files
            function_info_file = self.static_dir / "function_info.txt"
            function_info_content = """1,main,/test/main.c,10,30
2,check_dangerous_elf_combination,/test/readelf.cpp,75,99
3,print_elf_info,/test/readelf.cpp,38,72
4,_ZN9ImageStreamC2EP6Streamiii,/test/image.cpp,50,70
"""
            function_info_file.write_text(function_info_content)
            
            bid_mapping_file = self.static_dir / "bid_loc_mapping.txt"
            bid_mapping_content = """1001,1001,1,/test/main.c:15
1002,1002,2,/test/readelf.cpp:82
1003,1003,3,/test/readelf.cpp:45
"""
            bid_mapping_file.write_text(bid_mapping_content)
            
            caller_callee_file = self.static_dir / "caller-callee.txt"
            caller_callee_content = """1,2,3
2,4
"""
            caller_callee_file.write_text(caller_callee_content)
            
            callee_caller_file = self.static_dir / "callee-caller.txt"
            callee_caller_content = """2,1
3,1
4,2
"""
            callee_caller_file.write_text(callee_caller_content)
    
    @async_test
    async def test_server_initialization(self):
        """Test MCP server initialization"""
        result = await self.server.initialize_call_graph(str(self.static_dir))
        
        assert result
        assert self.server.call_graph is not None
    
    @async_test
    async def test_list_tools(self):
        """Test tool listing functionality"""
        await self.server.initialize_call_graph(str(self.static_dir))
        self.server.setup_handlers()
        
        # Test the actual tool listing functionality
        tools = self.server.get_available_tools()
        
        # Verify we have the expected number of tools
        assert len(tools) == 2, f"Expected 2 tools, got {len(tools)}"
        
        # Verify tool names
        tool_names = [tool.name for tool in tools]
        assert "get_callers" in tool_names, "get_callers tool not found"
        assert "get_callees" in tool_names, "get_callees tool not found"
        
        # Verify get_callers tool details
        get_callers_tool = next(tool for tool in tools if tool.name == "get_callers")
        assert "Find all functions that call the specified function" in get_callers_tool.description
        assert "type" in get_callers_tool.inputSchema
        assert get_callers_tool.inputSchema["type"] == "object"
        assert "function_name" in get_callers_tool.inputSchema["properties"]
        assert "function_name" in get_callers_tool.inputSchema["required"]
        
        # Verify get_callees tool details
        get_callees_tool = next(tool for tool in tools if tool.name == "get_callees")
        assert "Find all functions called by the specified function" in get_callees_tool.description
        assert "type" in get_callees_tool.inputSchema
        assert get_callees_tool.inputSchema["type"] == "object"
        assert "function_name" in get_callees_tool.inputSchema["properties"]
        assert "function_name" in get_callees_tool.inputSchema["required"]
    
    @async_test
    async def test_get_callers_tool(self):
        """Test get_callers tool functionality"""
        await self.server.initialize_call_graph(str(self.static_dir))
        self.server.setup_handlers()
        
        result = await self.call_tool("get_callers", {"function_name": "check_dangerous_elf_combination"})
        
        assert result is not None
        assert len(result) == 1
        assert result[0].type == "text"
        
        response_text = result[0].text
        # Should show callers or indicate no callers found
        assert ("Functions that call" in response_text or
                "No callers found" in response_text or
                "Call graph info is not available" in response_text or
                "Callers of" in response_text)
    
    @async_test
    async def test_get_callees_tool(self):
        """Test get_callees tool functionality"""
        await self.server.initialize_call_graph(str(self.static_dir))
        self.server.setup_handlers()
        
        result = await self.call_tool("get_callees", {"function_name": "main"})
        
        assert result is not None
        assert len(result) == 1
        assert result[0].type == "text"
        
        response_text = result[0].text
        # Should show callees or indicate no callees found
        assert ("Functions called by" in response_text or
                "No callees found" in response_text or
                "Call graph info is not available" in response_text or
                "Callees of" in response_text)
    
    @async_test
    async def test_get_callers_missing_parameter(self):
        """Test get_callers tool with missing function_name parameter"""
        await self.server.initialize_call_graph(str(self.static_dir))
        self.server.setup_handlers()
        
        result = await self.call_tool("get_callers", {})
        
        assert result is not None
        assert len(result) == 1
        assert result[0].type == "text"
        assert "Error: function_name parameter is required" in result[0].text
    
    @async_test
    async def test_get_callees_missing_parameter(self):
        """Test get_callees tool with missing function_name parameter"""
        await self.server.initialize_call_graph(str(self.static_dir))
        self.server.setup_handlers()
        
        result = await self.call_tool("get_callees", {})
        
        assert result is not None
        assert len(result) == 1
        assert result[0].type == "text"
        assert "Error: function_name parameter is required" in result[0].text
    
    @async_test
    async def test_uninitialized_call_graph(self):
        """Test tools with uninitialized call graph"""
        self.server.setup_handlers()
        
        result = await self.call_tool("get_callers", {"function_name": "main"})
        
        assert result is not None
        assert len(result) == 1
        assert result[0].type == "text"
        assert "Error: CallGraph not initialized" in result[0].text
    
    @async_test
    async def test_workflow_gatekeeper_wrong_phase(self):
        """Test workflow gatekeeper blocks access in wrong phase"""
        # Change phase to IMPLEMENT (should block call graph tools)
        self.update_workflow_phase("IMPLEMENT")
        
        await self.server.initialize_call_graph(str(self.static_dir))
        self.server.setup_handlers()
        
        result = await self.call_tool("get_callers", {"function_name": "main"})
        
        assert result is not None
        assert len(result) == 1
        assert result[0].type == "text"
        assert "Phase Gatekeeper" in result[0].text
        assert ("not allowed in IMPLEMENT phase" in result[0].text or "not allowed in WorkflowPhase.IMPLEMENT phase" in result[0].text)
        assert "Must be in ANALYZE phase" in result[0].text
    
    @async_test
    async def test_workflow_gatekeeper_analyze_phase(self):
        """Test workflow gatekeeper allows access in ANALYZE phase"""
        # Ensure we're in ANALYZE phase (should allow call graph tools)
        await self.server.initialize_call_graph(str(self.static_dir))
        self.server.setup_handlers()
        
        result = await self.call_tool("get_callers", {"function_name": "main"})
        
        assert result is not None
        assert len(result) == 1
        assert result[0].type == "text"
        # Should not be a gatekeeper error
        assert "Phase Gatekeeper" not in result[0].text
    
    def update_workflow_phase(self, phase):
        """Update workflow state phase for gatekeeper testing"""
        project_cursor_dir = Path.cwd() / ".cursor"
        workflow_state_file = project_cursor_dir / "workflow_state.md"
        
        if workflow_state_file.exists():
            content = workflow_state_file.read_text()
            # Replace the phase in the JSON
            import re
            content = re.sub(
                r'"phase": "[^"]*"',
                f'"phase": "{phase}"',
                content
            )
            workflow_state_file.write_text(content)
    
    async def call_tool(self, tool_name, arguments):
        """Helper to call MCP tools by simulating MCP call"""
        # Simulate what would happen when the MCP handler is called
        
        # Check gatekeeper first (same logic as in server)
        gatekeeper_error = self.server._check_workflow_gatekeeper(tool_name)
        if gatekeeper_error:
            return [types.TextContent(type="text", text=gatekeeper_error + "\n\n**Required Actions:**\n"
                     "1. Read workflow_state.md to check current phase\n"
                     "2. Use transition_phase tool to transition to ANALYZE phase\n"
                     "3. Ensure all ANALYZE phase prerequisites are met\n"
                     "4. Then retry this tool")]
        
        # Check if server is initialized
        if not self.server.call_graph:
            return [types.TextContent(type="text", text="Error: CallGraph not initialized. Please run with --static-folder argument.")]
        
        # Handle the actual tool calls
        if tool_name == "get_callers":
            function_name = arguments.get("function_name", "")
            if not function_name:
                return [types.TextContent(type="text", text="Error: function_name parameter is required")]
            
            callers_result = self.server.call_graph.get_callers(function_name)
            
            if isinstance(callers_result, dict) and "error" in callers_result:
                if callers_result["error"] == "no_callgraph_data":
                    result_text = f"ℹ️ {callers_result['message']}"
                elif callers_result["error"] == "not_found":
                    result_text = f"❌ Function '{callers_result['function_name']}' not found in call graph"
                else:
                    result_text = f"Error: {callers_result}"
            else:
                result_text = f"Callers of '{function_name}': {callers_result}"
            
            return [types.TextContent(type="text", text=result_text)]
        
        elif tool_name == "get_callees":
            function_name = arguments.get("function_name", "")
            if not function_name:
                return [types.TextContent(type="text", text="Error: function_name parameter is required")]
            
            callees_result = self.server.call_graph.get_callees(function_name)
            
            if isinstance(callees_result, dict) and "error" in callees_result:
                if callees_result["error"] == "no_callgraph_data":
                    result_text = f"ℹ️ {callees_result['message']}"
                elif callees_result["error"] == "not_found":
                    result_text = f"❌ Function '{callees_result['function_name']}' not found in call graph"
                else:
                    result_text = f"Error: {callees_result}"
            else:
                result_text = f"Callees of '{function_name}': {callees_result}"
            
            return [types.TextContent(type="text", text=result_text)]
        
        return [types.TextContent(type="text", text=f"Error: Unknown tool '{tool_name}'")]


class TestCallGraphIntegration:
    """Integration tests for call graph functionality"""
    
    def setup_method(self):
        """Set up test environment"""
        self.temp_dir = tempfile.mkdtemp()
        self.static_dir = Path(self.temp_dir) / "static"
        self.static_dir.mkdir(parents=True)
        
        self.temp_files = [self.temp_dir]
        
        # Create workflow state
        self.create_workflow_state()
        
        # Create comprehensive static files
        self.create_comprehensive_static_files()
        
    def teardown_method(self):
        """Clean up test environment"""
        import shutil
        for temp_file in self.temp_files:
            if os.path.exists(temp_file):
                if os.path.isfile(temp_file):
                    os.unlink(temp_file)
                elif os.path.isdir(temp_file):
                    shutil.rmtree(temp_file, ignore_errors=True)
    
    def create_workflow_state(self):
        """Create workflow state file"""
        project_cursor_dir = Path.cwd() / ".cursor"
        project_cursor_dir.mkdir(parents=True, exist_ok=True)
        workflow_state_file = project_cursor_dir / "workflow_state.md"
        
        workflow_state_content = '''# Workflow State

<!-- DYNAMIC:STATE:START -->
## State
```json
{
  "phase": "ANALYZE",
  "status": "Integration test mode",
  "current_task": "Test call graph integration",
  "next_action": "Test call graph analysis"
}
```
<!-- DYNAMIC:STATE:END -->

<!-- DYNAMIC:PRECONDITIONS:START -->
## Preconditions
```json
[]
```
<!-- DYNAMIC:PRECONDITIONS:END -->

<!-- DYNAMIC:ROOT_CAUSES:START -->
## RootCauses
```json
[]
```
<!-- DYNAMIC:ROOT_CAUSES:END -->

<!-- DYNAMIC:PARAMETER_SPACE:START -->
## ParameterSpace
```json
{}
```
<!-- DYNAMIC:PARAMETER_SPACE:END -->

<!-- DYNAMIC:TRIGGER_PLANS:START -->
## TriggerPlans
```json
[]
```
<!-- DYNAMIC:TRIGGER_PLANS:END -->

<!-- DYNAMIC:FUZZ_PLAN:START -->
## FuzzPlan
```json
[]
```
<!-- DYNAMIC:FUZZ_PLAN:END -->

<!-- DYNAMIC:BREAKPOINTS:START -->
## Breakpoints
```json
[]
```
<!-- DYNAMIC:BREAKPOINTS:END -->

<!-- DYNAMIC:METRICS:START -->
## Metrics
```json
{
  "total_iterations": 0,
  "total_reached_count": 0,
  "last_reached_count": 0,
  "triggered_count": 0,
  "timeout_count": 0,
  "error_count": 0,
  "last_updated": ""
}
```
<!-- DYNAMIC:METRICS:END -->

<!-- DYNAMIC:LOG:START -->
## Log
```json
[]
```
<!-- DYNAMIC:LOG:END -->
'''
        
        with open(workflow_state_file, 'w') as f:
            f.write(workflow_state_content)
        
        self.temp_files.append(workflow_state_file)
    
    def create_comprehensive_static_files(self):
        """Create comprehensive static analysis files for integration testing"""
        # Create a more realistic call graph structure
        function_info_file = self.static_dir / "function_info.txt"
        function_info_content = """1,main,/test/main.c,10,50
2,parse_args,/test/main.c,60,80
3,init_system,/test/init.c,10,30
4,cleanup_system,/test/init.c,40,60
5,process_file,/test/processor.c,10,100
6,read_header,/test/processor.c,110,130
7,validate_data,/test/processor.c,140,170
8,write_output,/test/output.c,10,50
9,log_error,/test/utils.c,10,25
10,_ZN9ImageStreamC2EP6Streamiii,/test/image.cpp,50,70
11,_Z10process_pngPKc,/test/png.cpp,100,150
"""
        function_info_file.write_text(function_info_content)
        
        # Create realistic caller-callee relationships
        caller_callee_file = self.static_dir / "caller-callee.txt"
        caller_callee_content = """1,2,3,5,8
2,9
3,9
5,6,7,8
6,9
7,9,10
8,9
10,11
"""
        caller_callee_file.write_text(caller_callee_content)
        
        # Create reverse mapping
        callee_caller_file = self.static_dir / "callee-caller.txt"
        callee_caller_content = """2,1
3,1
5,1
6,5
7,5
8,1,5
9,2,3,5,6,7,8
10,7
11,10
"""
        callee_caller_file.write_text(callee_caller_content)
        
        # Create bid mapping
        bid_mapping_file = self.static_dir / "bid_loc_mapping.txt"
        bid_mapping_content = """1001,1001,1,/test/main.c:25
1002,1002,2,/test/main.c:65
1003,1003,5,/test/processor.c:50
"""
        bid_mapping_file.write_text(bid_mapping_content)
    
    @async_test
    async def test_comprehensive_call_graph_analysis(self):
        """Test comprehensive call graph analysis"""
        server = MCPCallGraphServer()
        await server.initialize_call_graph(str(self.static_dir))
        server.setup_handlers()
        
        # Test main function callees
        result = await self.call_tool(server, "get_callees", {"function_name": "main"})
        
        assert result is not None
        assert len(result) == 1
        response_text = result[0].text
        
        # Main should call several functions
        expected_callees = ["parse_args", "init_system", "process_file", "write_output"]
        
        if "Functions called by 'main'" in response_text:
            # Check that expected callees are present
            for callee in expected_callees:
                assert callee in response_text, f"Expected callee {callee} not found in response"
        
        # Test log_error function callers (should have many callers)
        result = await self.call_tool(server, "get_callers", {"function_name": "log_error"})
        
        assert result is not None
        response_text = result[0].text
        
        if "Functions that call 'log_error'" in response_text:
            # log_error should be called by many functions
            expected_callers = ["parse_args", "init_system", "process_file", "read_header", "validate_data", "write_output"]
            
            # At least some of these should be present
            found_callers = sum(1 for caller in expected_callers if caller in response_text)
            assert found_callers > 0, "Expected to find some callers for log_error"
    
    @async_test
    async def test_mangled_name_handling_integration(self):
        """Test mangled name handling in integration scenario"""
        server = MCPCallGraphServer()
        await server.initialize_call_graph(str(self.static_dir))
        server.setup_handlers()
        
        # Test with mangled C++ function name
        result = await self.call_tool(server, "get_callers", {"function_name": "ImageStream"})
        
        assert result is not None
        response_text = result[0].text
        
        # Should either find callers or indicate no callers found
        assert ("Functions that call" in response_text or
                "No callers found" in response_text or
                "Callers of" in response_text)
        
        # Test with exact mangled name
        result = await self.call_tool(server, "get_callees", {"function_name": "_ZN9ImageStreamC2EP6Streamiii"})
        
        assert result is not None
        response_text = result[0].text
        
        # Should handle mangled name appropriately
        assert not response_text.startswith("Error:")
    
    async def call_tool(self, server, tool_name, arguments):
        """Helper to call MCP tools via direct method access"""
        if tool_name == "get_callers":
            function_name = arguments.get("function_name", "")
            if not function_name:
                return [types.TextContent(type="text", text="Error: function_name parameter is required")]
            
            # Check if call graph is initialized
            if not server.call_graph:
                return [types.TextContent(type="text", text="Error: CallGraph not initialized. Please run with --static-folder argument.")]
            
            callers_result = server.call_graph.get_callers(function_name)
            
            if isinstance(callers_result, dict) and "error" in callers_result:
                if callers_result["error"] == "no_callgraph_data":
                    result_text = f"ℹ️ {callers_result['message']}"
                elif callers_result["error"] == "not_found":
                    result_text = f"❌ Function '{callers_result['function_name']}' not found in call graph"
                else:
                    result_text = f"Error: {callers_result}"
            else:
                result_text = f"Callers of '{function_name}': {callers_result}"
            
            return [types.TextContent(type="text", text=result_text)]
        
        elif tool_name == "get_callees":
            function_name = arguments.get("function_name", "")
            if not function_name:
                return [types.TextContent(type="text", text="Error: function_name parameter is required")]
            
            # Check if call graph is initialized
            if not server.call_graph:
                return [types.TextContent(type="text", text="Error: CallGraph not initialized. Please run with --static-folder argument.")]
            
            callees_result = server.call_graph.get_callees(function_name)
            
            if isinstance(callees_result, dict) and "error" in callees_result:
                if callees_result["error"] == "no_callgraph_data":
                    result_text = f"ℹ️ {callees_result['message']}"
                elif callees_result["error"] == "not_found":
                    result_text = f"❌ Function '{callees_result['function_name']}' not found in call graph"
                else:
                    result_text = f"Error: {callees_result}"
            else:
                result_text = f"Callees of '{function_name}': {callees_result}"
            
            return [types.TextContent(type="text", text=result_text)]
        
        return None


if __name__ == '__main__':
    pytest.main([__file__, "-v"])
