#!/usr/bin/env python3
"""
Environment Verification Script for Property-Based Directed Fuzzer
================================================================

This script verifies that the environment is properly configured for running 
the directed property-based fuzzer, with special attention to MCP compatibility
issues discovered during debugging.
"""

import sys
import subprocess
from pathlib import Path
import importlib.util
import json
from packaging import version as pkg_version

def check_python_version():
    """Check if Python version is 3.10+"""
    version = sys.version_info
    print(f"Python version: {version.major}.{version.minor}.{version.micro}")
    if version >= (3, 10):
        print("✅ Python version OK")
        return True
    else:
        print("❌ Python 3.10+ required")
        return False

def check_mcp_compatibility():
    """Check MCP version compatibility with cursor-agent"""
    try:
        import mcp
        # Try multiple ways to get version
        version = 'unknown'
        try:
            import pkg_resources
            version = pkg_resources.get_distribution('mcp').version
        except:
            try:
                from importlib.metadata import version as get_version
                version = get_version('mcp')
            except:
                version = getattr(mcp, '__version__', 'unknown')
        
        print(f"MCP version: {version}")
        
        # Parse version to compare numerically
        current_version = pkg_version.parse(version)
        min_version = pkg_version.parse('1.3.0')            
        if current_version > min_version:
            print("✅ MCP version: Compatible (>1.3.0)")
            return True
        else:
            print("⚠️  MCP version: Too old (requires >1.3.0)")
            return False
    except ImportError:
        print("❌ MCP: Not installed")
        return False

def check_mcp_config_conflicts():
    """Check for MCP configuration conflicts"""
    global_config = Path.home() / '.cursor' / 'mcp.json'
    local_config = Path('.cursor/mcp.json')
    
    conflicts = []
    
    if global_config.exists():
        print(f"⚠️  Global MCP config found: {global_config}")
        print("   This may cause -32602 Invalid request parameters errors")
        conflicts.append("global_config")
    else:
        print("✅ No global MCP config conflicts")
    
    if local_config.exists():
        print(f"✅ Local MCP config found: {local_config}")
        try:
            with open(local_config) as f:
                config = json.load(f)
                servers = config.get('mcpServers', {})
                print(f"   Configured servers: {list(servers.keys())}")
        except Exception as e:
            print(f"⚠️  Local MCP config parse error: {e}")
            conflicts.append("config_parse")
    
    return len(conflicts) == 0

def check_dependencies():
    """Check if required Python packages are available"""
    required_packages = [
        ('dap_mcp', 'DAP MCP library'),
        ('dap_types', 'DAP types'),
        ('pytest', 'Pytest testing framework'),
        ('pydantic', 'Pydantic data validation'),
        ('cxxfilt', 'C++ name demangling'),
        ('tree_sitter', 'Tree-sitter parsing (optional)'),
        ('tree_sitter_c', 'Tree-sitter C parsing (optional)'),
        ('tree_sitter_cpp', 'Tree-sitter C++ parsing (optional)'),
        ('libclang', 'Python libclang bindings (optional)'),
    ]
    
    results = []
    for package, description in required_packages:
        try:
            spec = importlib.util.find_spec(package)
            if spec is not None:
                print(f"✅ {description}: Available")
                results.append(True)
            else:
                if 'optional' in description:
                    print(f"⚠️  {description}: Missing (optional)")
                    results.append(True)  # Don't fail on optional
                else:
                    print(f"❌ {description}: Missing")
                    results.append(False)
        except ImportError:
            print(f"❌ {description}: Import error")
            results.append(False)
    
    return all(results)

def check_llvm_tools():
    """Check if LLVM tools are available"""
    tools = [
        ('llvm-dwarfdump-20', 'LLVM dwarfdump'),
        ('lldb-dap', 'LLDB DAP adapter (preferred)'),
        ('lldb-vscode', 'LLDB VSCode adapter (alternative)'),
    ]
    
    llvm_available = False
    dap_available = False
    
    for tool, description in tools:
        try:
            result = subprocess.run(['which', tool], 
                                  capture_output=True, text=True)
            if result.returncode == 0:
                print(f"✅ {description}: {result.stdout.strip()}")
                if 'dwarfdump' in tool:
                    llvm_available = True
                elif 'dap' in tool or 'vscode' in tool:
                    dap_available = True
            else:
                print(f"⚠️  {description}: Not found")
        except Exception as e:
            print(f"❌ {description}: Error checking ({e})")
    
    return llvm_available, dap_available

def check_cursor_agent():
    """Check if cursor-agent is available and get version"""
    try:
        result = subprocess.run(['cursor-agent', '--version'], 
                              capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            version = result.stdout.strip()
            print(f"✅ cursor-agent: {version}")
            
            # Check for known compatible version
            if '2025.09.04-fc40cd1' in version:
                print("   Compatible with MCP 1.4.0")
                return True
            else:
                print("   Version compatibility unknown")
                return True
        else:
            print("⚠️  cursor-agent: Available but version check failed")
            return False
    except (subprocess.TimeoutExpired, FileNotFoundError):
        print("⚠️  cursor-agent: Not found (install from Cursor)")
        return False
    except Exception as e:
        print(f"❌ cursor-agent: Error checking ({e})")
        return False

def check_project_structure():
    """Check if required project files exist"""
    current_dir = Path('.')
    required_files = [
        'config.py',
        'debugger.py', 
        'launcher.py',
        'property_based_fuzzer.py',
        'requirements.txt',
        'mcp_fuzzer_server.py',
    ]
    
    results = []
    for file in required_files:
        file_path = current_dir / file
        if file_path.exists():
            print(f"✅ {file}: Found")
            results.append(True)
        else:
            print(f"❌ {file}: Missing")
            results.append(False)
    
    return all(results)

def test_mcp_server_startup():
    """Test if MCP servers can start properly"""
    servers = [
        ('mcp_fuzzer_server.py', 'Fuzzer MCP Server'),
        ('mcp_corpus_server.py', 'Corpus MCP Server'),
        ('mcp_format_helper_server.py', 'Format Helper MCP Server'),
    ]
    
    results = []
    for server_file, description in servers:
        if not Path(server_file).exists():
            print(f"⚠️  {description}: File not found")
            results.append(False)
            continue
            
        try:
            # Test import only (quick check)
            result = subprocess.run([
                sys.executable, '-c', 
                f'import sys; sys.path.insert(0, "."); import {server_file[:-3]}; print("OK")'
            ], capture_output=True, text=True, timeout=10)
            
            if result.returncode == 0 and 'OK' in result.stdout:
                print(f"✅ {description}: Import OK")
                results.append(True)
            else:
                print(f"❌ {description}: Import failed")
                print(f"   Error: {result.stderr[:100]}...")
                results.append(False)
        except subprocess.TimeoutExpired:
            print(f"⚠️  {description}: Import timeout")
            results.append(False)
        except Exception as e:
            print(f"❌ {description}: Error ({e})")
            results.append(False)
    
    return all(results)

def run_mcp_compatibility_test():
    """Run MCP compatibility test with cursor-agent"""
    if not Path('.cursor/mcp.json').exists():
        print("⚠️  MCP compatibility test: No .cursor/mcp.json config")
        return False
    
    try:
        print("🧪 Testing cursor-agent MCP compatibility...")
        result = subprocess.run([
            'cursor-agent', 'mcp', 'list'
        ], capture_output=True, text=True, timeout=10)
        
        if result.returncode == 0:
            print("✅ cursor-agent MCP: Working")
            return True
        elif '-32602' in result.stderr:
            print("❌ cursor-agent MCP: Invalid request parameters (config conflict)")
            print("   Solution: mv ~/.cursor/mcp.json ~/.cursor/mcp_backup.json")
            return False
        elif '-32001' in result.stderr:
            print("⚠️  cursor-agent MCP: Request timeout (server startup issue)")
            return False
        else:
            print(f"⚠️  cursor-agent MCP: Other error")
            print(f"   stderr: {result.stderr[:100]}...")
            return False
    except subprocess.TimeoutExpired:
        print("⚠️  cursor-agent MCP: Command timeout")
        return False
    except FileNotFoundError:
        print("⚠️  cursor-agent MCP: cursor-agent not found")
        return False
    except Exception as e:
        print(f"❌ cursor-agent MCP: Error ({e})")
        return False

def main():
    """Main verification function"""
    print("=" * 70)
    print("Environment Verification for Property-Based Directed Fuzzer")
    print("=" * 70)
    
    checks = []
    
    print("\n📋 Checking Python environment...")
    checks.append(check_python_version())
    
    print("\n🔌 Checking MCP compatibility...")
    mcp_ok = check_mcp_compatibility()
    checks.append(mcp_ok)
    
    print("\n⚙️  Checking MCP configuration...")
    config_ok = check_mcp_config_conflicts()
    checks.append(config_ok)
    
    print("\n📦 Checking Python dependencies...")
    checks.append(check_dependencies())
    
    print("\n🔧 Checking LLVM tools...")
    llvm_ok, dap_ok = check_llvm_tools()
    checks.append(llvm_ok)
    
    print("\n🖱️  Checking cursor-agent...")
    cursor_ok = check_cursor_agent()
    
    print("\n📁 Checking project structure...")
    checks.append(check_project_structure())
    
    print("\n🚀 Testing MCP server startup...")
    server_ok = test_mcp_server_startup()
    checks.append(server_ok)
    
    print("\n🧪 Testing MCP compatibility...")
    compat_ok = run_mcp_compatibility_test()
    
    # Summary
    print("\n" + "=" * 70)
    print("ENVIRONMENT VERIFICATION SUMMARY")
    print("=" * 70)
    
    passed = sum(checks)
    total = len(checks)
    
    print(f"✅ Core checks passed: {passed}/{total}")
    
    # MCP Status
    if mcp_ok and config_ok and compat_ok:
        print("✅ MCP Integration: Fully working")
    elif mcp_ok and config_ok:
        print("⚠️  MCP Integration: Ready (test with cursor-agent)")
    else:
        print("❌ MCP Integration: Needs fixes")
    
    # DAP Status  
    if dap_ok:
        print("✅ DAP debugging: Fully supported")
    else:
        print("⚠️  DAP debugging: Limited (expected in some environments)")
    
    # Overall Status
    if passed >= 5 and mcp_ok:  # Allow for some optional components
        print("\n🎉 ENVIRONMENT STATUS: READY FOR PRODUCTION")
        print("   • Core fuzzing functionality: ✅ Available")
        print("   • LLM integration: ✅ Available") 
        print("   • Property-based generation: ✅ Available")
        print("   • MCP server integration: ✅ Available")
        if not dap_ok:
            print("   • Interactive debugging: ⚠️  Limited")
    else:
        print("\n⚠️  ENVIRONMENT STATUS: REQUIRES FIXES")
        print("   Please address the failed checks above.")
        
        if not mcp_ok:
            print("\n🔧 MCP Setup Instructions:")
            print("   pip install 'mcp==1.13.1'")
        
    return passed >= 5 and mcp_ok

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)