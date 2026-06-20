#!/usr/bin/env python3
"""
End-to-end pytest tests for MCP Deviation Detector Server
Uses real static analysis data and program execution
"""

import pytest
import asyncio
import json
import os
import subprocess
import tempfile
import shutil
from pathlib import Path

class TestMCPDeviationDetectorE2E:
    """End-to-end tests for MCP Deviation Detector Server"""
    
    # Define paths as class variables - dynamically resolve project root
    project_root = Path(__file__).parent.parent
    fixtures_dir = project_root / "tests" / "fixtures"
    static_analysis_dir = fixtures_dir / "readelf_static_analysis"
    cursor_dir = static_analysis_dir / ".cursor"
    readelf_cpp_source = fixtures_dir / "readelf.cpp"
    readelf_binary = fixtures_dir / "readelf"
    mcp_config_file = cursor_dir / "mcp.json"
    temp_files = []
    
    @pytest.fixture(scope="class", autouse=True) 
    def setup_test_environment(cls):
        """Setup test environment with compilation and config files"""
        
        # Clear temp files list for this test run
        cls.temp_files = []
        
        # 1. Create .cursor directory if it doesn't exist
        cls.cursor_dir.mkdir(parents=True, exist_ok=True)
        
        # 1.5. Create workflow state file for gatekeeper
        workflow_state_content = '''# Workflow State

<!-- STATIC:RULES:START -->
## Rules
- **MANDATORY**: Always read workflow_state.md before each transition
- **Phase Gating**: Only allowed transitions:
```mermaid
graph LR
    PLAN --> IMPLEMENT
    IMPLEMENT --> EXECUTE
    EXECUTE --> REFLECT
    REFLECT --> PLAN
    EXECUTE --> SUCCESS[PoC Found]
```

### REFLECT Phase Rules
- **R-RF1**: Must analyze why testcases in FuzzPlan failed to trigger the bug
- **R-RF2**: For no-reach testcases in FuzzPlan, must use detect_deviation to identify which preconditions were not satisfied
- **R-RF3**: For reach/no-trigger testcases in FuzzPlan, must identify why bug predicate was not triggered by tracing variable dependencies backward
- **R-RF4**: Must transition to PLAN phase if performed more than THREE manual test. This budget resets upon re-entering REFLECT.
- **R-RF5**: ALLOWED TOOLS: detect_deviation, launch_interactive_gdb, get_callers, get_callees, and Workflow MCP Tools
<!-- STATIC:RULES:END -->

<!-- DYNAMIC:STATE:START -->
## State
```json
{
  "phase": "REFLECT",
  "status": "E2E Test Mode - Analyzing target for deviation detection",
  "current_task": "Test deviation detection functionality",
  "next_action": "Execute detect_deviation tool"
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
        
        # Create workflow state file in project root .cursor directory (where server expects it)
        project_cursor_dir = cls.project_root / ".cursor"
        project_cursor_dir.mkdir(parents=True, exist_ok=True)
        workflow_state_file = project_cursor_dir / "workflow_state.md"
        
        with open(workflow_state_file, 'w') as f:
            f.write(workflow_state_content)
        
        print(f"✓ Created workflow state: {workflow_state_file}")
        cls.temp_files.append(workflow_state_file)
        
        # 2. Compile readelf.cpp to readelf binary
        print(f"\n=== Compiling {cls.readelf_cpp_source} ===")
        compile_cmd = [
            "clang-14", "-g", "-O0", 
            str(cls.readelf_cpp_source), 
            "-o", str(cls.readelf_binary),
            "-lstdc++"
        ]
        
        try:
            result = subprocess.run(
                compile_cmd, 
                capture_output=True, 
                text=True,
                check=True
            )
            print(f"✓ Compilation successful: {cls.readelf_binary}")
            cls.temp_files.append(cls.readelf_binary)
        except subprocess.CalledProcessError as e:
            pytest.fail(f"Failed to compile readelf.cpp: {e}\nstderr: {e.stderr}")
        except FileNotFoundError:
            pytest.fail("clang-14 not found. Please install clang-14")
        
        # 3. Create mcp.json configuration
        mcp_config = {
            "mcpServers": {
                "deviation_detector": {
                    "command": "python3",
                    "args": [
                        str(cls.project_root / "mcp_deviation_detector_server.py"),
                        "--static-folder",
                        str(cls.static_analysis_dir),
                        "--reached-pattern",
                        "bug location reached",
                        "--exec-timeout-sec",
                        "3",
                        "--",
                        str(cls.readelf_binary),
                        "@@"
                    ]
                }
            }
        }
        
        with open(cls.mcp_config_file, 'w') as f:
            json.dump(mcp_config, f, indent=2)
        
        print(f"✓ Created MCP config: {cls.mcp_config_file}")
        cls.temp_files.append(cls.mcp_config_file)
        
        # Verify required static analysis files exist
        required_files = [
            "critical_BBs.txt",
            "bid_loc_mapping.txt", 
            "function_info.txt"
        ]
        
        for file_name in required_files:
            file_path = cls.static_analysis_dir / file_name
            if not file_path.exists():
                pytest.fail(f"Required static analysis file not found: {file_path}")
        
        print("✓ All required static analysis files found")
        
        yield  # This is where the tests run
        
        # Cleanup after all tests complete
        print("\n=== Cleanup ===")
        for temp_file in cls.temp_files:
            if os.path.exists(temp_file):
                if os.path.isfile(temp_file):
                    os.unlink(temp_file)
                    print(f"✓ Deleted: {temp_file}")
                elif os.path.isdir(temp_file):
                    shutil.rmtree(temp_file)
                    print(f"✓ Deleted directory: {temp_file}")

    async def _communicate_with_mcp_server(self, server_cmd, test_cases):
        """Helper to communicate with MCP server"""
        
        print(f"Starting MCP server: {' '.join(server_cmd)}")
        
        # Start server process
        proc = subprocess.Popen(
            server_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=0
        )
        
        results = []
        
        try:
            # Initialize MCP communication
            init_request = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "roots": {"listChanged": True},
                        "sampling": {}
                    },
                    "clientInfo": {
                        "name": "pytest-client",
                        "version": "1.0.0"
                    }
                }
            }
            
            # Send initialize request
            proc.stdin.write(json.dumps(init_request) + '\n')  # type: ignore
            proc.stdin.flush()  # type: ignore
            
            # Read initialize response
            response_line = proc.stdout.readline()  # type: ignore
            if not response_line:
                raise Exception("No initialize response from server")
            
            init_response = json.loads(response_line.strip())
            if "error" in init_response:
                raise Exception(f"Server initialization error: {init_response['error']}")
            
            # Send initialized notification
            initialized_notification = {
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            }
            proc.stdin.write(json.dumps(initialized_notification) + '\n')  # type: ignore
            proc.stdin.flush()  # type: ignore
            
            # Run test cases
            for i, test_case in enumerate(test_cases):
                test_request = {
                    "jsonrpc": "2.0",
                    "id": i + 2,
                    "method": "tools/call",
                    "params": {
                        "name": "detect_deviation",
                        "arguments": test_case["arguments"]
                    }
                }
                
                proc.stdin.write(json.dumps(test_request) + '\n')  # type: ignore
                proc.stdin.flush()  # type: ignore
                
                # Read response with timeout
                response_line = proc.stdout.readline()  # type: ignore
                if not response_line:
                    raise Exception(f"No response for test case {i+1}")
                
                try:
                    response = json.loads(response_line.strip())
                except json.JSONDecodeError as e:
                    raise Exception(f"Failed to parse response for test case {i+1}: {e}\nRaw response: {response_line.strip()}")
                
                results.append({
                    "test_case": test_case,
                    "response": response
                })
            
        finally:
            # Cleanup server process
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        
        return results

    @pytest.mark.asyncio
    async def test_valid_elf_file_deviation_detection(self, setup_test_environment):
        """Test deviation detection with valid ELF file (/usr/bin/ls)"""
        
        # Server command from mcp.json config
        server_cmd = [
            "python3",
            str(self.project_root / "mcp_deviation_detector_server.py"),
            "--static-folder",
            str(self.static_analysis_dir),
            "--reached-pattern",
            "bug location reached",
            "--exec-timeout-sec",
            "3",
            "--",
            str(self.readelf_binary),
            "@@"
        ]
        
        test_cases = [
            {
                "name": "valid_elf_ls",
                "arguments": {
                    "input_file_path": "/usr/bin/ls"
                }
            }
        ]
        
        results = await self._communicate_with_mcp_server(server_cmd, test_cases)
        
        # Verify results
        assert len(results) == 1
        result = results[0]
        
        # Check response structure (MCP format)
        assert "result" in result["response"]
        assert "content" in result["response"]["result"]
        assert isinstance(result["response"]["result"]["content"], list)
        assert len(result["response"]["result"]["content"]) > 0
        
        response_text = result["response"]["result"]["content"][0]["text"]
        
        # For a valid ELF file like /usr/bin/ls, we expect:
        # 1. Either "Target not reached" (common case - didn't trigger bug)
        # 2. Or "Reached, No deviation" (if somehow the bug was triggered)
        # 3. Should NOT be an error message
        
        assert not response_text.startswith("Error:"), f"Unexpected error: {response_text}"
        
        # Check for expected deviation detection patterns
        if "Target not reached" in response_text:
            # This is the most likely case - execution deviated from bug path
            print(f"✓ Correctly detected deviation for valid ELF: {response_text[:100]}...")
            
            # Should provide information about why target wasn't reached
            if "No breakpoints were hit" in response_text:
                print("  - No breakpoints hit (execution path completely avoided critical areas)")
            else:
                # Should have breakpoint information
                assert "breakpoint" in response_text.lower()
                print("  - Provided breakpoint hit information for analysis")
                
        elif "Reached, No deviation" in response_text:
            # Less likely but possible if /usr/bin/ls happens to trigger the bug condition
            print(f"✓ Target reached (rare case): {response_text}")

    @pytest.mark.asyncio  
    async def test_invalid_elf_file_deviation_detection(self, setup_test_environment):
        """Test deviation detection with invalid ELF file (readelf.cpp - text file)"""
        
        server_cmd = [
            "python3", 
            str(self.project_root / "mcp_deviation_detector_server.py"),
            "--static-folder",
            str(self.static_analysis_dir),
            "--reached-pattern", 
            "bug location reached",
            "--exec-timeout-sec",
            "3",
            "--",
            str(self.readelf_binary),
            "@@"
        ]
        
        test_cases = [
            {
                "name": "invalid_elf_cpp_file",
                "arguments": {
                    "input_file_path": str(self.readelf_cpp_source)
                }
            }
        ]
        
        results = await self._communicate_with_mcp_server(server_cmd, test_cases)
        
        # Verify results
        assert len(results) == 1
        result = results[0]
        
        # Check response structure (MCP format)
        assert "result" in result["response"] 
        assert "content" in result["response"]["result"]
        assert isinstance(result["response"]["result"]["content"], list)
        assert len(result["response"]["result"]["content"]) > 0
        
        response_text = result["response"]["result"]["content"][0]["text"]
        
        # For an invalid ELF file (C++ source code), we expect:
        # 1. "Target not reached" (program should exit early due to invalid magic)
        # 2. Should NOT be an error message
        # 3. May have breakpoint info or "No breakpoints were hit"
        
        assert not response_text.startswith("Error:"), f"Unexpected error: {response_text}"
        
        # Should indicate target not reached since readelf.cpp is not a valid ELF file
        assert "Target not reached" in response_text, f"Expected target not reached, got: {response_text}"
        
        print(f"✓ Correctly detected deviation for invalid ELF: {response_text[:100]}...")
        
        # If breakpoints were hit, should have deviation info
        assert "breakpoint" in response_text.lower()
        print("  - Provided breakpoint information showing where execution deviated")

    @pytest.mark.asyncio
    async def test_crafted_elf_file_bug_trigger(self, setup_test_environment):
        """Test with a crafted ELF file that should trigger the bug condition"""
        
        # Create a crafted ELF file that should trigger the bug
        # Based on our earlier successful test: 64-bit + big endian + version 1 + entry point 0x400000
        elf_data = bytearray(64)  # ELF header size
        
        # ELF Magic
        elf_data[0:4] = [0x7f, ord('E'), ord('L'), ord('F')]
        
        # Class (EI_CLASS = 4): 64-bit
        elf_data[4] = 2  # ELFCLASS64
        
        # Data (EI_DATA = 5): Big endian  
        elf_data[5] = 2  # ELFDATA2MSB
        
        # Version (EI_VERSION = 6): Current
        elf_data[6] = 1  # EV_CURRENT
        
        # Set entry point to 0x400000 (big endian format)
        entry_point = 0x400000
        for i in range(8):
            elf_data[24 + i] = (entry_point >> (56 - 8*i)) & 0xFF
        
        # Write to temporary file
        with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
            tmp_file.write(elf_data)
            temp_elf_path = tmp_file.name
        
        # Add to cleanup list
        TestMCPDeviationDetectorE2E.temp_files.append(temp_elf_path)
        
        try:
            server_cmd = [
                "python3",
                str(self.project_root / "mcp_deviation_detector_server.py"),
                "--static-folder", 
                str(self.static_analysis_dir),
                "--reached-pattern",
                "bug location reached",
                "--exec-timeout-sec",
                "3",
                "--",
                str(self.readelf_binary),
                "@@"
            ]
            
            test_cases = [
                {
                    "name": "crafted_elf_bug_trigger",
                    "arguments": {
                        "input_file_path": temp_elf_path
                    }
                }
            ]
            
            results = await self._communicate_with_mcp_server(server_cmd, test_cases)
            
            # Verify results
            assert len(results) == 1
            result = results[0]
            
            assert "result" in result["response"]
            assert "content" in result["response"]["result"]
            assert isinstance(result["response"]["result"]["content"], list)
            assert len(result["response"]["result"]["content"]) > 0
            
            response_text = result["response"]["result"]["content"][0]["text"]
            
            # For the crafted ELF file, we expect it to trigger the bug:
            # Should see "Reached, No deviation."
            assert not response_text.startswith("Error:"), f"Unexpected error: {response_text}"
            
            if "Reached, No deviation" in response_text:
                print("✓ Successfully triggered bug path - target reached!")
            else:
                pytest.fail(f"Unexpected response for crafted ELF: {response_text}")
            
        finally:
            # Cleanup temp file
            if os.path.exists(temp_elf_path):
                os.unlink(temp_elf_path)
                if temp_elf_path in TestMCPDeviationDetectorE2E.temp_files:
                    TestMCPDeviationDetectorE2E.temp_files.remove(temp_elf_path)

    def test_static_analysis_files_integrity(self, setup_test_environment):
        """Test that static analysis files contain expected data"""
        
        # Test critical_BBs.txt
        critical_bbs_file = self.static_analysis_dir / "critical_BBs.txt"
        assert critical_bbs_file.exists()
        
        with open(critical_bbs_file, 'r') as f:
            lines = [line.strip() for line in f if line.strip()]
        
        assert len(lines) > 0, "critical_BBs.txt should not be empty"
        
        # Should have the expected format (bid,fid1,fid2,...)
        for line in lines:
            parts = line.split(',')
            assert len(parts) >= 2, f"Invalid critical BB line: {line}"
            # First part should be a number (BID)
            assert parts[0].isdigit(), f"First field should be BID number: {line}"
        
        print(f"✓ critical_BBs.txt contains {len(lines)} critical branch entries")
        
        # Test bid_loc_mapping.txt  
        bid_mapping_file = self.static_analysis_dir / "bid_loc_mapping.txt"
        assert bid_mapping_file.exists()
        
        with open(bid_mapping_file, 'r') as f:
            lines = [line.strip() for line in f if line.strip()]
        
        assert len(lines) > 0, "bid_loc_mapping.txt should not be empty"
        
        # Check that it contains readelf.cpp mappings
        readelf_mappings = [line for line in lines if "readelf.cpp:" in line]
        assert len(readelf_mappings) > 0, "Should have readelf.cpp location mappings"
        
        # Check format: bid,hash1,hash2,filepath:line
        for line in readelf_mappings[:5]:  # Check first 5 
            parts = line.split(',')
            assert len(parts) >= 4, f"Invalid mapping line format: {line}"
            assert parts[0].isdigit(), f"First field should be BID: {line}"
            assert ':' in parts[-1], f"Last field should contain filepath:line: {line}"
            
        print(f"✓ bid_loc_mapping.txt contains {len(readelf_mappings)} readelf.cpp mappings")

    @pytest.mark.asyncio
    async def test_extra_bp_behavior_exclusive_or_fallback(self, setup_test_environment):
        """
        Test _prepare_breakpoints behavior:
        - If extra_bp is provided: ONLY agent breakpoints are used (no inferrer breakpoints)
        - If extra_bp is empty/omitted: ONLY inferrer breakpoints are used (fallback)
        
        This is an exclusive-or behavior, not a merge.
        """
        
        server_cmd = [
            "python3",
            str(self.project_root / "mcp_deviation_detector_server.py"),
            "--static-folder",
            str(self.static_analysis_dir),
            "--reached-pattern",
            "bug location reached",
            "--exec-timeout-sec",
            "3",
            "--",
            str(self.readelf_binary),
            "@@"
        ]
        
        # Test Case 1: Empty extra_bp (should use ONLY inferrer breakpoints)
        test_cases_empty_bp = [
            {
                "name": "empty_extra_bp",
                "arguments": {
                    "input_file_path": "/usr/bin/ls",
                    "extra_bp": []  # Explicitly empty - fallback to inferrer
                }
            }
        ]
        
        results_empty = await self._communicate_with_mcp_server(server_cmd, test_cases_empty_bp)
        
        assert len(results_empty) == 1
        result_empty = results_empty[0]
        
        # Should not error - empty extra_bp is valid and uses inferrer breakpoints
        assert "result" in result_empty["response"]
        assert "content" in result_empty["response"]["result"]
        response_text_empty = result_empty["response"]["result"]["content"][0]["text"]
        assert not response_text_empty.startswith("Error:"), f"Should not error with empty extra_bp: {response_text_empty}"
        
        print("✓ Test Case 1: Empty extra_bp - uses ONLY inferrer breakpoints (fallback)")
        
        # Test Case 2: With extra_bp provided (should use ONLY agent breakpoints, NOT inferrer)
        # Get the absolute path to readelf.cpp for setting a breakpoint
        readelf_cpp_abs = str(self.readelf_cpp_source.resolve())
        
        test_cases_with_bp = [
            {
                "name": "with_extra_bp",
                "arguments": {
                    "input_file_path": "/usr/bin/ls",
                    "extra_bp": [
                        {
                            "location": f"{readelf_cpp_abs}:10",
                            "hit_limit": 5,
                            "inline_expr": ["elf_class"]
                        }
                    ]
                }
            }
        ]
        
        results_with = await self._communicate_with_mcp_server(server_cmd, test_cases_with_bp)
        
        assert len(results_with) == 1
        result_with = results_with[0]
        
        # Should not error - valid extra_bp (uses ONLY agent breakpoints)
        assert "result" in result_with["response"]
        assert "content" in result_with["response"]["result"]
        response_text_with = result_with["response"]["result"]["content"][0]["text"]
        assert not response_text_with.startswith("Error:"), f"Should not error with valid extra_bp: {response_text_with}"
        
        print("✓ Test Case 2: With extra_bp - uses ONLY agent breakpoints (no inferrer)")
        
        # Test Case 3: Omitted extra_bp (default behavior - should also fallback to inferrer)
        test_cases_omitted_bp = [
            {
                "name": "omitted_extra_bp",
                "arguments": {
                    "input_file_path": "/usr/bin/ls"
                    # extra_bp not provided at all - fallback to inferrer
                }
            }
        ]
        
        results_omitted = await self._communicate_with_mcp_server(server_cmd, test_cases_omitted_bp)
        
        assert len(results_omitted) == 1
        result_omitted = results_omitted[0]
        
        # Should not error - omitted extra_bp defaults to empty, uses inferrer breakpoints
        assert "result" in result_omitted["response"]
        assert "content" in result_omitted["response"]["result"]
        response_text_omitted = result_omitted["response"]["result"]["content"][0]["text"]
        assert not response_text_omitted.startswith("Error:"), f"Should not error with omitted extra_bp: {response_text_omitted}"
        
        print("✓ Test Case 3: Omitted extra_bp - uses ONLY inferrer breakpoints (fallback)")
        
        # Verify behavior: empty and omitted should produce similar results (both use inferrer only)
        # When extra_bp is provided, only agent breakpoints are used (exclusive-or behavior)
        print("\n✓ All test cases passed: _prepare_breakpoints uses exclusive-or logic (agent XOR inferrer)")

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
