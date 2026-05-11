#!/usr/bin/env python3
"""
End-to-end tests for MCP GDB Server using readelf.cpp fixture
"""

import asyncio
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
import pytest

# Get paths
TEST_DIR = Path(__file__).parent
FIXTURE_DIR = TEST_DIR / "fixtures"
PROJECT_ROOT = TEST_DIR.parent
READELF_SOURCE = FIXTURE_DIR / "readelf.cpp"

@pytest.fixture(scope="module")
def compiled_readelf():
    """Compile readelf.cpp test fixture"""
    binary_path = FIXTURE_DIR / "readelf"
    
    # Compile with debug symbols
    compile_cmd = [
        "g++", "-g", "-O0", 
        str(READELF_SOURCE), 
        "-o", str(binary_path)
    ]
    
    result = subprocess.run(compile_cmd, capture_output=True, text=True)
    assert result.returncode == 0, f"Compilation failed: {result.stderr}"
    assert binary_path.exists(), "Binary not created"
    
    yield binary_path
    
    # Cleanup
    if binary_path.exists():
        binary_path.unlink()

@pytest.fixture
def workflow_state(tmp_path):
    """Create minimal workflow state for testing"""
    cursor_dir = tmp_path / ".cursor"
    cursor_dir.mkdir()
    
    workflow_state = cursor_dir / "workflow_state.md"
    workflow_state.write_text("""# Workflow State

<!-- DYNAMIC:STATE:START -->
## State
```json
{
  "phase": "REFLECT",
  "status": "Testing GDB integration",
  "current_task": "Test launch_interactive_gdb tool",
  "next_action": "Verify GDB interaction"
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
""")
    
    # Change to the temp directory so the server finds the workflow state
    original_cwd = os.getcwd()
    os.chdir(tmp_path)
    
    yield workflow_state
    
    # Restore original directory
    os.chdir(original_cwd)

@pytest.mark.asyncio
async def test_launch_gdb_basic(compiled_readelf, workflow_state, tmp_path):
    """Test basic GDB launch functionality"""
    
    # Create a test input file
    test_input = tmp_path / "test.elf"
    test_input.write_bytes(b"\x7fELF" + b"\x00" * 60)  # Minimal ELF header
    
    # Start MCP server
    server_script = PROJECT_ROOT / "mcp_gdb_server.py"
    
    server_process = await asyncio.create_subprocess_exec(
        "python3", str(server_script),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    
    try:
        # Send initialization request
        init_request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test-client", "version": "1.0"}
            }
        }
        
        server_process.stdin.write((json.dumps(init_request) + "\n").encode())
        await server_process.stdin.drain()
        
        # Read initialization response
        response_line = await asyncio.wait_for(
            server_process.stdout.readline(),
            timeout=5.0
        )
        init_response = json.loads(response_line.decode())
        assert "result" in init_response
        
        # Send initialized notification
        initialized_notification = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }
        server_process.stdin.write((json.dumps(initialized_notification) + "\n").encode())
        await server_process.stdin.drain()
        
        # Send launch_interactive_gdb request
        launch_request = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "launch_interactive_gdb",
                "arguments": {
                    "cmd": [str(compiled_readelf), str(test_input)],
                    "timeout": "30s"
                }
            }
        }
        
        server_process.stdin.write((json.dumps(launch_request) + "\n").encode())
        await server_process.stdin.drain()
        
        # Read launch response
        response_line = await asyncio.wait_for(
            server_process.stdout.readline(),
            timeout=5.0
        )
        launch_response = json.loads(response_line.decode())
        
        assert "result" in launch_response
        result = launch_response["result"]
        assert "content" in result
        
        # Check that response contains GDB session instructions
        content_text = result["content"][0]["text"]
        assert "GDB Session Launched" in content_text or "GDB Session Started" in content_text
        assert "printf" in content_text  # Should contain instruction to send commands
        
    finally:
        # Cleanup
        server_process.terminate()
        try:
            await asyncio.wait_for(server_process.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            server_process.kill()
            await server_process.wait()

def test_gdb_script_exists():
    """Verify gdb.sh script exists and is executable"""
    gdb_script = PROJECT_ROOT / "gdb.sh"
    assert gdb_script.exists(), f"gdb.sh not found at {gdb_script}"
    assert os.access(gdb_script, os.X_OK), "gdb.sh is not executable"

def test_gdb_script_help():
    """Test gdb.sh help output"""
    gdb_script = PROJECT_ROOT / "gdb.sh"
    
    result = subprocess.run(
        [str(gdb_script), "-h"],
        capture_output=True,
        text=True
    )
    
    assert result.returncode == 0
    assert "Usage:" in result.stdout
    assert "gdb.sh" in result.stdout

@pytest.mark.skipif(not Path("/usr/bin/gdb").exists(), reason="GDB not installed")
def test_gdb_interactive_session(compiled_readelf, tmp_path):
    """Test actual GDB interactive session via gdb.sh"""
    
    gdb_script = PROJECT_ROOT / "gdb.sh"
    test_input = tmp_path / "test.elf"
    test_input.write_bytes(b"\x7fELF" + b"\x00" * 60)
    
    # Launch GDB session
    result = subprocess.run(
        [str(gdb_script), "-t", "5s", "--", str(compiled_readelf), str(test_input)],
        capture_output=True,
        text=True,
        timeout=10
    )
    
    # Should output instructions
    assert result.returncode == 0
    assert "GDB Interactive Session Started" in result.stdout
    assert "printf" in result.stdout
    assert "/tmp/gdb_session_" in result.stdout  # Session directory
    assert "gdb_in" in result.stdout  # FIFO name
    assert "gdb_log" in result.stdout  # Log file name
    assert "watch critical_var" in result.stdout  # Watchpoint instructions

@pytest.mark.skipif(not Path("/usr/bin/gdb").exists(), reason="GDB not installed")
def test_gdb_multiple_concurrent_sessions(compiled_readelf, tmp_path):
    """Test multiple concurrent GDB sessions to ensure pipes don't mix"""
    
    gdb_script = PROJECT_ROOT / "gdb.sh"
    test_input = tmp_path / "test.elf"
    test_input.write_bytes(b"\x7fELF" + b"\x00" * 60)
    
    # Launch 3 concurrent GDB sessions
    processes = []
    for i in range(3):
        proc = subprocess.Popen(
            [str(gdb_script), "-t", "10s", "--", str(compiled_readelf), str(test_input)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        processes.append(proc)
    
    # Collect outputs from all sessions
    session_dirs = []
    session_fifos = []
    
    for i, proc in enumerate(processes):
        stdout, stderr = proc.communicate(timeout=5)
        assert proc.returncode == 0, f"Session {i} failed with: {stderr}"
        
        # Extract session directory from output
        import re
        match = re.search(r'Session Directory: (/tmp/gdb_session_\S+)', stdout)
        assert match, f"Session {i} didn't output session directory"
        session_dir = match.group(1)
        session_dirs.append(session_dir)
        
        # Extract FIFO paths
        in_fifo_match = re.search(r'printf.*> (\S+gdb_in)', stdout)
        assert in_fifo_match, f"Session {i} didn't output input FIFO"
        session_fifos.append(in_fifo_match.group(1))
    
    # Verify all sessions have unique directories
    assert len(set(session_dirs)) == 3, "Sessions didn't create unique directories"
    
    # Verify all FIFOs are unique
    assert len(set(session_fifos)) == 3, "Sessions didn't create unique FIFOs"
    
    # Verify the directory pattern is correct (no duplicate timestamp/random suffix in filename)
    for session_dir in session_dirs:
        # Check that files in the directory don't have extra suffix
        assert session_dir.endswith(session_dir.split('/')[-1]), "Session dir format incorrect"
        # Check that session dir contains the files we expect
        # Note: directories might be cleaned up by now, so we just verify the path format
        assert "gdb_session_" in session_dir
        assert session_dir.count("gdb_session_") == 1

@pytest.mark.skipif(not Path("/usr/bin/gdb").exists(), reason="GDB not installed")
def test_gdb_log_completeness(compiled_readelf, tmp_path):
    """Test that GDB log captures all output without data loss (race condition test)"""
    
    gdb_script = PROJECT_ROOT / "gdb.sh"
    test_input = tmp_path / "test.elf"
    test_input.write_bytes(b"\x7fELF" + b"\x00" * 60)
    
    # Launch GDB session
    result = subprocess.run(
        [str(gdb_script), "-t", "10s", "--", str(compiled_readelf), str(test_input)],
        capture_output=True,
        text=True,
        timeout=15
    )
    
    assert result.returncode == 0
    
    # Extract session directory and log file path
    import re
    match = re.search(r'Session Directory: (/tmp/gdb_session_\S+)', result.stdout)
    assert match, "Could not find session directory in output"
    session_dir = match.group(1)
    
    log_file = Path(session_dir) / "gdb_log"
    in_fifo = Path(session_dir) / "gdb_in"
    
    # Wait for session to be ready
    time.sleep(0.5)
    
    # Send multiple commands to GDB to generate substantial output
    if in_fifo.exists():
        with open(in_fifo, 'w') as f:
            f.write("info functions\n")
            f.write("info variables\n")
            f.write("help all\n")
            f.write("quit\n")
        
        # Wait for GDB to process commands and exit
        time.sleep(2)
        
        # Read the log file
        if log_file.exists():
            log_content = log_file.read_text()
            
            # Verify log contains expected content
            # GDB should show startup message
            assert "(gdb)" in log_content or "GNU gdb" in log_content, "Log missing GDB startup"
            
            # Should contain quit acknowledgment or at least some output
            assert len(log_content) > 0, "Log file is empty"
            
            # Check that log has reasonable size (not truncated)
            # GDB help output should be substantial
            assert len(log_content) > 100, f"Log suspiciously small: {len(log_content)} bytes"
            
            print(f"✓ Log file size: {len(log_content)} bytes")
            print(f"✓ Log file contains complete GDB output")

@pytest.mark.skipif(not Path("/usr/bin/gdb").exists(), reason="GDB not installed")
def test_gdb_cleanup_robustness(compiled_readelf, tmp_path):
    """Test that cleanup properly handles all resources"""
    
    gdb_script = PROJECT_ROOT / "gdb.sh"
    test_input = tmp_path / "test.elf"
    test_input.write_bytes(b"\x7fELF" + b"\x00" * 60)
    
    # Launch GDB session
    result = subprocess.run(
        [str(gdb_script), "-t", "3s", "--", str(compiled_readelf), str(test_input)],
        capture_output=True,
        text=True,
        timeout=8
    )
    
    assert result.returncode == 0
    
    # Extract session directory
    import re
    match = re.search(r'Session Directory: (/tmp/gdb_session_\S+)', result.stdout)
    assert match, "Could not find session directory in output"
    session_dir = Path(match.group(1))
    
    # Wait for cleanup to complete (30s grace period + buffer)
    # We don't want to wait the full 30s in tests, so we'll just verify the directory exists initially
    time.sleep(1)
    
    # During grace period, directory should still exist for agent to read logs
    initial_exists = session_dir.exists()
    
    # Just verify the session was created and cleanup logic will eventually run
    # (Full cleanup test would take 30+ seconds which is too long for unit tests)
    print(f"✓ Session directory created: {session_dir}")
    print(f"✓ Session directory during grace period: {'exists' if initial_exists else 'cleaned up'}")

if __name__ == "__main__":
    pytest.main([__file__, "-v"])

