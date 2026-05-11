#!/usr/bin/env python3
"""
End-to-end tests for MCP Workflow Server

Tests the complete workflow server functionality including:
- write_workflow_block with gatekeeper validation
- transition_phase with prerequisite checks
- check_phase_completion
"""

import json
import pytest
import tempfile
import shutil
from pathlib import Path
from datetime import datetime

# Import workflow server components
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from mcp_workflow_server import (
    parse_json_block,
    replace_json_block,
    validate_phase_transition,
    check_data_modification_permission,
    check_plan_phase_completion,
    check_implement_phase_completion,
    check_execute_phase_completion,
    check_execute_phase_requirements,
    check_reflect_phase_completion,
    get_phase_info,
    get_allowed_next_phases
)


@pytest.fixture
def temp_workflow_dir():
    """Create a temporary .cursor directory with workflow_state.md"""
    temp_dir = tempfile.mkdtemp()
    cursor_dir = Path(temp_dir) / ".cursor"
    cursor_dir.mkdir(parents=True)
    
    # Copy template workflow_state.md
    template_path = Path(__file__).parent.parent / "templates" / "workflow_state.md"
    workflow_path = cursor_dir / "workflow_state.md"
    shutil.copy2(template_path, workflow_path)
    
    # Create project_config.md for crashes_dir detection
    project_config = cursor_dir / "project_config.md"
    project_config.write_text(f"""# Project Configuration
- **Output Directory**: {temp_dir}/output
""")
    
    # Change to temp directory so workflow server can find the files
    original_cwd = Path.cwd()
    import os
    os.chdir(temp_dir)
    
    yield {
        'dir': Path(temp_dir),
        'cursor_dir': cursor_dir,
        'workflow_file': workflow_path,
        'project_config': project_config
    }
    
    # Cleanup
    os.chdir(original_cwd)
    shutil.rmtree(temp_dir)


def test_parse_json_block(temp_workflow_dir):
    """Test parsing JSON blocks from workflow state"""
    workflow_file = temp_workflow_dir['workflow_file']
    content = workflow_file.read_text()
    
    # Test State block
    state = parse_json_block(content, "State")
    assert isinstance(state, dict)
    assert state['phase'] == 'INIT'
    assert 'status' in state
    
    # Test empty lists
    preconditions = parse_json_block(content, "Preconditions")
    assert isinstance(preconditions, list)
    assert len(preconditions) == 0
    
    # Test Metrics block
    metrics = parse_json_block(content, "Metrics")
    assert isinstance(metrics, dict)
    assert metrics['total_iterations'] == 0


def test_replace_json_block(temp_workflow_dir):
    """Test replacing JSON blocks in workflow state"""
    workflow_file = temp_workflow_dir['workflow_file']
    content = workflow_file.read_text()
    
    # Replace State block
    new_state = {
        "phase": "PLAN",
        "status": "Analyzing target",
        "current_task": "Test task",
        "next_action": "Test action"
    }
    new_content = replace_json_block(content, "State", new_state)
    
    # Verify replacement
    parsed_state = parse_json_block(new_content, "State")
    assert parsed_state['phase'] == 'PLAN'
    assert parsed_state['status'] == 'Analyzing target'
    
    # Write back and verify persistence
    workflow_file.write_text(new_content)
    content_after = workflow_file.read_text()
    parsed_state_after = parse_json_block(content_after, "State")
    assert parsed_state_after['phase'] == 'PLAN'


def test_validate_phase_transition():
    """Test phase transition validation"""
    # Valid transitions
    assert validate_phase_transition("INIT", "PLAN") == True
    assert validate_phase_transition("PLAN", "IMPLEMENT") == True
    assert validate_phase_transition("IMPLEMENT", "EXECUTE") == True
    assert validate_phase_transition("EXECUTE", "REFLECT") == True
    assert validate_phase_transition("EXECUTE", "SUCCESS") == True
    assert validate_phase_transition("REFLECT", "PLAN") == True
    
    # Invalid transitions
    assert validate_phase_transition("INIT", "IMPLEMENT") == False
    assert validate_phase_transition("PLAN", "EXECUTE") == False
    assert validate_phase_transition("IMPLEMENT", "REFLECT") == False
    assert validate_phase_transition("EXECUTE", "PLAN") == False
    assert validate_phase_transition("REFLECT", "EXECUTE") == False


def test_check_data_modification_permission():
    """Test data modification permissions for each phase"""
    assert check_data_modification_permission("INIT", "BuildInfo") == True
    assert check_data_modification_permission("INIT", "BugPredicates") == False
    # PLAN phase permissions
    assert check_data_modification_permission("PLAN", "BugPredicates") == True
    assert check_data_modification_permission("PLAN", "Preconditions") == True
    assert check_data_modification_permission("PLAN", "RootCauses") == True
    assert check_data_modification_permission("PLAN", "TriggerPlans") == True
    assert check_data_modification_permission("PLAN", "FuzzPlan") == False
    assert check_data_modification_permission("PLAN", "Breakpoints") == False
    assert check_data_modification_permission("PLAN", "Metrics") == False
    assert check_data_modification_permission("PLAN", "BuildInfo") == True
    
    # IMPLEMENT phase permissions
    assert check_data_modification_permission("IMPLEMENT", "ParameterSpace") == True
    assert check_data_modification_permission("IMPLEMENT", "FuzzPlan") == True
    assert check_data_modification_permission("IMPLEMENT", "Breakpoints") == True
    assert check_data_modification_permission("IMPLEMENT", "Preconditions") == False
    assert check_data_modification_permission("IMPLEMENT", "Metrics") == False
    
    # EXECUTE phase permissions
    assert check_data_modification_permission("EXECUTE", "Metrics") == True
    assert check_data_modification_permission("EXECUTE", "FuzzPlan") == False
    assert check_data_modification_permission("EXECUTE", "Preconditions") == False
    
    # REFLECT phase permissions (read-only)
    assert check_data_modification_permission("REFLECT", "Metrics") == False
    assert check_data_modification_permission("REFLECT", "Preconditions") == False
    assert check_data_modification_permission("REFLECT", "FuzzPlan") == False


def test_check_plan_phase_completion(temp_workflow_dir):
    """Test PLAN phase completion check"""
    workflow_file = temp_workflow_dir['workflow_file']
    content = workflow_file.read_text()
    
    # Initial state - incomplete
    completed, missing = check_plan_phase_completion(content)
    assert completed == False
    assert len(missing) >= 3  # No BugPredicates, Preconditions, RootCauses, TriggerPlans
    
    # Add required data
    content = replace_json_block(content, "BugPredicates", [
        {
            "id": "BP1",
            "location": "test.c:10",
            "condition": "x > 100",
            "description": "Test bug predicate"
        }
    ])
    content = replace_json_block(content, "Preconditions", [
        {
            "id": "R1",
            "statement": "Test precondition",
            "status": "verified",
            "evidence": ["Test evidence"],
            "input_constraints": []
        }
    ])
    content = replace_json_block(content, "RootCauses", [
        {
            "id": "RC1",
            "description": "Test root cause",
            "category": "buffer_overflow",
            "evidence": ["Test evidence"],
            "input_constraints": [],
            "related_precondition_ids": ["R1"]
        }
    ])
    content = replace_json_block(content, "TriggerPlans", [
        {
            "id": "TP1",
            "description": "Test plan",
            "route_description": "Test route",
            "complexity": 5,
            "status": "pending",
            "evidence": [],
            "precondition_ids": ["R1"],
            "strategy": "Test strategy"
        }
    ])
    
    # Check completion again - should be complete
    completed, missing = check_plan_phase_completion(content)
    assert completed == True
    assert len(missing) == 0


def test_check_implement_phase_completion(temp_workflow_dir):
    """Test IMPLEMENT phase completion check"""
    workflow_file = temp_workflow_dir['workflow_file']
    content = workflow_file.read_text()
    
    # Initial state - incomplete
    completed, missing = check_implement_phase_completion(content)
    assert completed == False
    assert "FuzzPlan is empty" in str(missing) or "FuzzPlan" in str(missing)
    assert "No breakpoints defined" in str(missing) or "breakpoints" in str(missing)
    
    # Add FuzzPlan with < 5 tests - still incomplete
    content = replace_json_block(content, "FuzzPlan", [
        {"plan_description": "Test 1", "length": 10},
        {"plan_description": "Test 2", "length": 20}
    ])
    completed, missing = check_implement_phase_completion(content)
    assert completed == False
    assert "must have 5-10 concrete tests" in str(missing)
    
    # Add enough tests
    content = replace_json_block(content, "FuzzPlan", [
        {"plan_description": f"Test {i}", "length": i*10} 
        for i in range(1, 6)
    ])
    
    # Add breakpoints
    content = replace_json_block(content, "Breakpoints", [
        {
            "location": "/tmp/test.c:100",
            "hit_limit": 10,
            "inline_expr": ["length", "size"],
            "print_call_stack": False
        }
    ])
    
    # Check completion - should be complete
    completed, missing = check_implement_phase_completion(content)
    assert completed == True
    assert len(missing) == 0


def test_check_execute_phase_completion(temp_workflow_dir):
    """Test EXECUTE phase completion check
    
    EXECUTE phase requires Metrics to be updated with fuzzing results.
    """
    workflow_file = temp_workflow_dir['workflow_file']
    content = workflow_file.read_text()
    
    # EXECUTE phase requires updated Metrics
    content = replace_json_block(content, "Metrics", {
        "total_iterations": 10,
        "total_reached_count": 5,
        "last_reached_count": 5,
        "triggered_count": 0,
        "timeout_count": 0,
        "error_count": 0,
        "last_updated": datetime.now().isoformat()
    })
    
    completed, missing = check_execute_phase_completion(content)
    assert completed == True
    assert len(missing) == 0


def test_check_execute_phase_requirements(temp_workflow_dir):
    """Test EXECUTE phase requirements check (what to do after execute)"""
    workflow_file = temp_workflow_dir['workflow_file']
    content = workflow_file.read_text()
    
    # No reach, no trigger - should return NEED_DEVIATION_ANALYSIS
    content = replace_json_block(content, "Metrics", {
        "total_iterations": 10,
        "total_reached_count": 0,
        "last_reached_count": 0,
        "triggered_count": 0,
        "timeout_count": 0,
        "error_count": 0,
        "last_updated": datetime.now().isoformat()
    })
    action, recommendations = check_execute_phase_requirements(content)
    assert action == "NEED_DEVIATION_ANALYSIS"
    assert "R-RF" in str(recommendations)
    
    # Reached but not triggered - should return NEED_BACKWARD_ANALYSIS
    content = replace_json_block(content, "Metrics", {
        "total_iterations": 10,
        "total_reached_count": 5,
        "last_reached_count": 5,
        "triggered_count": 0,
        "timeout_count": 0,
        "error_count": 0,
        "last_updated": datetime.now().isoformat()
    })
    action, recommendations = check_execute_phase_requirements(content)
    assert action == "NEED_BACKWARD_ANALYSIS"
    assert "R-RF" in str(recommendations)
    
    # Triggered - success (needs output_dir with crashes)
    content = replace_json_block(content, "Metrics", {
        "total_iterations": 10,
        "total_reached_count": 5,
        "last_reached_count": 5,
        "triggered_count": 1,
        "timeout_count": 0,
        "error_count": 0,
        "last_updated": datetime.now().isoformat()
    })
    
    # Create crashes directory with PoC file
    output_dir = temp_workflow_dir['dir'] / "output"
    crashes_dir = output_dir / "crashes"
    crashes_dir.mkdir(parents=True, exist_ok=True)
    (crashes_dir / "poc_test.txt").write_text("test poc")
    
    action, recommendations = check_execute_phase_requirements(content, output_dir)
    assert action == "SUCCESS"
    assert "R-RF" in str(recommendations)


def test_workflow_integration_flow(temp_workflow_dir):
    """Test complete workflow integration flow"""
    workflow_file = temp_workflow_dir['workflow_file']
    
    # 1. Start in PLAN phase
    content = workflow_file.read_text()
    state = parse_json_block(content, "State")
    assert state['phase'] == 'INIT'
    
    # 2. Add PLAN phase data
    content = replace_json_block(content, "BugPredicates", [
        {
            "id": "BP1",
            "location": "test.c:100",
            "condition": "x > 100",
            "description": "Buffer overflow condition"
        }
    ])
    content = replace_json_block(content, "Preconditions", [
        {
            "id": "R1",
            "statement": "Input must be valid format",
            "status": "verified",
            "evidence": ["Test evidence"],
            "input_constraints": ["format == 'valid'"]
        }
    ])
    content = replace_json_block(content, "RootCauses", [
        {
            "id": "RC1",
            "description": "Buffer overflow when length > 100",
            "category": "buffer_overflow",
            "evidence": ["Crash at line 100"],
            "input_constraints": ["length > 100"],
            "related_precondition_ids": ["R1"]
        }
    ])
    content = replace_json_block(content, "TriggerPlans", [
        {
            "id": "TP1",
            "description": "Trigger buffer overflow with large length",
            "route_description": "main -> process_input -> vulnerable_function",
            "complexity": 3,
            "status": "pending",
            "evidence": ["Found overflow at line 100"],
            "precondition_ids": ["R1"],
            "strategy": "Use large length value"
        }
    ])
    workflow_file.write_text(content)
    
    # 4. Check ANALYZE completion
    content = workflow_file.read_text()
    completed, missing = check_plan_phase_completion(content)
    assert completed == True
    
    # 3. Transition to IMPLEMENT
    content = replace_json_block(content, "State", {
        "phase": "PREPARE",
        "status": "Preparing fuzz plan",
        "current_task": "Generate concrete tests",
        "next_action": "Set breakpoints"
    })
    workflow_file.write_text(content)
    
    # 6. Add PREPARE phase data
    content = workflow_file.read_text()
    content = replace_json_block(content, "FuzzPlan", [
        {"plan_description": f"Test RC1 with length={100+i*10}", "length": 100+i*10, "format": "valid"}
        for i in range(1, 6)
    ])
    content = replace_json_block(content, "Breakpoints", [
        {
            "location": "/tmp/test.c:100",
            "hit_limit": 10,
            "inline_expr": ["length", "buffer_size"],
            "print_call_stack": True
        }
    ])
    workflow_file.write_text(content)
    
    # 7. Check PREPARE completion
    content = workflow_file.read_text()
    completed, missing = check_implement_phase_completion(content)
    assert completed == True
    
    print("✅ Complete workflow integration flow test passed!")


def test_check_reflect_phase_completion():
    """Test REFLECT phase completion (no prerequisites currently)"""
    from mcp_workflow_server import check_reflect_phase_completion
    
    # REFLECT phase currently has no static prerequisites
    # It's an analysis phase that transitions back to PLAN after analysis
    content = """
<!-- DYNAMIC:METRICS:START -->
## Metrics
```json
{
  "total_iterations": 10,
  "total_reached_count": 0,
  "last_reached_count": 0,
  "triggered_count": 0,
  "timeout_count": 0,
  "error_count": 0,
  "last_updated": ""
}
```
<!-- DYNAMIC:METRICS:END -->
"""
    completed, missing = check_reflect_phase_completion(content)
    assert completed == True
    assert len(missing) == 0
    print("✓ REFLECT phase has no static prerequisites")


def test_get_phase_info():
    """Test get_phase_info helper function"""
    # Test PLAN phase
    info = get_phase_info("PLAN")
    assert "Planning phase" in info['description']
    assert info['rules'] == [
        "R-PL1", "R-PL2", "R-PL3", "R-PL4", "R-PL5", "R-PL6", "R-PL7", "R-PL8",
    ]
    
    # Test IMPLEMENT phase
    info = get_phase_info("IMPLEMENT")
    assert "Implementation phase" in info['description']
    assert info['rules'] == ["R-IM1", "R-IM2", "R-IM3", "R-IM4", "R-IM5"]
    
    # Test EXECUTE phase
    info = get_phase_info("EXECUTE")
    assert "Execution phase" in info['description']
    assert info['rules'] == ["R-EX1", "R-EX2", "R-EX3", "R-EX4", "R-EX5"]
    
    # Test REFLECT phase
    info = get_phase_info("REFLECT")
    assert "Reflection phase" in info['description']
    assert info['rules'] == ["R-RF1", "R-RF2", "R-RF3", "R-RF4", "R-RF5"]
    
    # Test SUCCESS phase
    info = get_phase_info("SUCCESS")
    assert info['description'] == "Success phase - PoC found"
    assert info['rules'] == []
    
    # Test unknown phase
    info = get_phase_info("UNKNOWN")
    assert info['description'] == "Unknown phase"
    assert info['rules'] == []
    
    print("✅ get_phase_info test passed!")


def test_get_allowed_next_phases():
    """Test get_allowed_next_phases helper function"""
    assert get_allowed_next_phases("INIT") == ["PLAN"]
    # Test PLAN phase
    next_phases = get_allowed_next_phases("PLAN")
    assert next_phases == ["IMPLEMENT"]
    
    # Test IMPLEMENT phase
    next_phases = get_allowed_next_phases("IMPLEMENT")
    assert next_phases == ["EXECUTE"]
    
    # Test EXECUTE phase (two possible transitions)
    next_phases = get_allowed_next_phases("EXECUTE")
    assert set(next_phases) == {"REFLECT", "SUCCESS"}
    assert len(next_phases) == 2
    
    # Test REFLECT phase
    next_phases = get_allowed_next_phases("REFLECT")
    assert next_phases == ["PLAN"]
    
    # Test SUCCESS phase (terminal state)
    next_phases = get_allowed_next_phases("SUCCESS")
    assert next_phases == []
    
    # Test unknown phase
    next_phases = get_allowed_next_phases("UNKNOWN")
    assert next_phases == []
    
    print("✅ get_allowed_next_phases test passed!")


def test_get_current_phase_info_integration(temp_workflow_dir):
    """Test get_current_phase integration with workflow state"""
    workflow_file = temp_workflow_dir['workflow_file']
    
    # Test 1: INIT phase (template default)
    content = workflow_file.read_text()
    state = parse_json_block(content, "State")
    assert state['phase'] == 'INIT'
    
    phase_info = get_phase_info(state['phase'])
    next_phases = get_allowed_next_phases(state['phase'])
    
    assert "Environment setup" in phase_info['description']
    assert next_phases == ["PLAN"]
    print("✓ Test 1: INIT phase info correct")
    
    # Test 2: IMPLEMENT phase
    content = replace_json_block(content, "State", {
        "phase": "IMPLEMENT",
        "status": "Creating execution plan",
        "current_task": "Test task",
        "next_action": "Test action"
    })
    workflow_file.write_text(content)
    
    content = workflow_file.read_text()
    state = parse_json_block(content, "State")
    assert state['phase'] == 'IMPLEMENT'
    
    phase_info = get_phase_info(state['phase'])
    next_phases = get_allowed_next_phases(state['phase'])
    
    assert "Implementation phase" in phase_info['description']
    assert phase_info['rules'] == ["R-IM1", "R-IM2", "R-IM3", "R-IM4", "R-IM5"]
    assert next_phases == ["EXECUTE"]
    print("✓ Test 2: IMPLEMENT phase info correct")
    
    # Test 3: EXECUTE phase (special case with two next phases)
    content = replace_json_block(content, "State", {
        "phase": "EXECUTE",
        "status": "Executing fuzzing",
        "current_task": "Run fuzzing",
        "next_action": "Check results"
    })
    workflow_file.write_text(content)
    
    content = workflow_file.read_text()
    state = parse_json_block(content, "State")
    assert state['phase'] == 'EXECUTE'
    
    phase_info = get_phase_info(state['phase'])
    next_phases = get_allowed_next_phases(state['phase'])
    
    assert "Execution phase" in phase_info['description']
    assert phase_info['rules'] == ["R-EX1", "R-EX2", "R-EX3", "R-EX4", "R-EX5"]
    assert set(next_phases) == {"REFLECT", "SUCCESS"}
    print("✓ Test 3: EXECUTE phase info correct (two next phases)")
    
    # Test 4: SUCCESS phase (terminal state)
    content = replace_json_block(content, "State", {
        "phase": "SUCCESS",
        "status": "PoC found!",
        "current_task": "Complete",
        "next_action": "Terminate workflow"
    })
    workflow_file.write_text(content)
    
    content = workflow_file.read_text()
    state = parse_json_block(content, "State")
    assert state['phase'] == 'SUCCESS'
    
    phase_info = get_phase_info(state['phase'])
    next_phases = get_allowed_next_phases(state['phase'])
    
    assert phase_info['description'] == "Success phase - PoC found"
    assert phase_info['rules'] == []
    assert next_phases == []
    print("✓ Test 4: SUCCESS phase info correct (no next phases)")
    
    print("✅ get_current_phase integration test passed!")

def test_phase_rules_coverage():
    """Test that all phases with rules have correct rule naming"""
    phases_with_rules = {
        "INIT": "R-IN",
        "PLAN": "R-PL",
        "IMPLEMENT": "R-IM",
        "EXECUTE": "R-EX",
        "REFLECT": "R-RF"
    }
    
    for phase, rule_prefix in phases_with_rules.items():
        info = get_phase_info(phase)
        rules = info['rules']
        
        # Check that all rules start with correct prefix
        assert all(rule.startswith(rule_prefix) for rule in rules), \
            f"{phase} rules should all start with '{rule_prefix}'"
        
        # Check that rules are in order
        rule_numbers = [int(rule.split(rule_prefix)[1]) for rule in rules]
        assert rule_numbers == sorted(rule_numbers), \
            f"{phase} rules should be in numeric order"
        
        # Check that rules start from 1
        assert rule_numbers[0] == 1, \
            f"{phase} rules should start from 1"
    
    print("✅ Phase rules coverage test passed!")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

