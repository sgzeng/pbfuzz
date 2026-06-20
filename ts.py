# ===============================
# Tree-sitter based utilities
# ===============================
import os
import collections

try:
    # Tree-sitter Python bindings - using official individual language packages
    from tree_sitter import Language, Parser
    
    # Import individual language modules (official pattern)
    C_LANGUAGE = None
    CPP_LANGUAGE = None
    
    try:
        import tree_sitter_c
        C_LANGUAGE = Language(tree_sitter_c.language())
    except ImportError:
        pass
        
    try:
        import tree_sitter_cpp
        CPP_LANGUAGE = Language(tree_sitter_cpp.language())
    except ImportError:
        pass
    
    # Availability flags
    C_PARSER_AVAILABLE = C_LANGUAGE is not None
    CPP_PARSER_AVAILABLE = CPP_LANGUAGE is not None
            
except ImportError:  # pragma: no cover - optional dependency
    Parser = None
    Language = None
    C_LANGUAGE = None
    CPP_LANGUAGE = None
    C_PARSER_AVAILABLE = False
    CPP_PARSER_AVAILABLE = False


def get_language_parser(lang_key):
    """Get parser for the specified language key using official API"""
    if Parser is None:
        return None
    if lang_key == 'c' and C_LANGUAGE:
        return Parser(C_LANGUAGE)
    elif lang_key == 'cpp' and CPP_LANGUAGE:
        return Parser(CPP_LANGUAGE)
    else:
        return None


def get_parser_for_file_ts(filepath):
    """
    Return a configured Parser instance for the file extension using Tree-sitter.
    Supports both C and C++ files using the official get_parser API.
    """
    if Parser is None or get_language_parser is None:
        return None
    
    ext = os.path.splitext(filepath)[1].lower()
    
    # Determine language based on file extension
    if ext == '.c':
        lang_key = 'c'
        if not C_PARSER_AVAILABLE:
            return None
    elif ext in ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.h']:
        lang_key = 'cpp'
        if not CPP_PARSER_AVAILABLE:
            # Fallback to C parser for C++ files if C++ parser not available
            lang_key = 'c'
            if not C_PARSER_AVAILABLE:
                return None
    else:
        # Default to C grammar for unknown extensions
        lang_key = 'c'
        if not C_PARSER_AVAILABLE:
            return None
    
    try:
        # Use official get_parser API directly
        parser = get_language_parser(lang_key)
        return parser
    except Exception:
        # If parser creation fails, return None to trigger fallback
        return None


def extract_identifier_name_ts(node, source_bytes):
    """Recursively find the first identifier name under the given node."""
    try:
        if node.type == 'identifier':
            return source_bytes[node.start_byte:node.end_byte].decode(errors='ignore')
    except Exception:
        pass
    named_children = getattr(node, 'named_children', [])
    if named_children:
        for child in named_children:
            name = extract_identifier_name_ts(child, source_bytes)
            if name:
                return name
    return ""


def find_enclosing_function_name_ts(filepath, lineno):
    """
    Use Tree-sitter to find the function name that encloses a 1-based line number in filepath.
    Returns empty string if not found or on failure.
    """
    parser = get_parser_for_file_ts(filepath)
    if parser is None:
        return ""
    try:
        with open(filepath, 'rb') as f:
            source = f.read()
    except Exception:
        return ""
    try:
        tree = parser.parse(source)
    except Exception:
        return ""
    row = max(0, lineno - 1)

    # DFS to find innermost function_definition (C/C++) containing the row
    def contains_line(n):
        return n.start_point[0] <= row <= n.end_point[0]

    best = None
    stack = [tree.root_node]
    while stack:
        n = stack.pop()
        if not contains_line(n):
            continue
        if n.type == 'function_definition':
            # prefer the innermost (smallest range that still contains row)
            if best is None:
                best = n
            else:
                br = best.end_point[0] - best.start_point[0]
                nr = n.end_point[0] - n.start_point[0]
                if nr <= br:
                    best = n
        # continue traversal
        named_children = getattr(n, 'named_children', [])
        if named_children:
            for c in named_children:
                if contains_line(c):
                    stack.append(c)

    if best is None:
        return ""
    # Extract identifier under the declarator field
    decl = best.child_by_field_name('declarator') if hasattr(best, 'child_by_field_name') else None
    if decl is None:
        # fallback: search identifier under best
        return extract_identifier_name_ts(best, source)
    # In C/C++, function name is the identifier under declarator subtree
    name = extract_identifier_name_ts(decl, source)
    return name


def find_guid_by_func_name_ts(function_name, function_infos):
    """
    Use Tree-sitter to find a function by exact identifier name across the
    known function files and return its GUID if found. Returns None otherwise.
    """
    if Parser is None:
        return None
    # iterate over known functions grouped by filepath to avoid reparsing same file
    seen_files = set()
    for guid, info in function_infos.items():
        fp = info[1]
        if not fp or not os.path.isfile(fp):
            continue
        if fp in seen_files:
            continue
        seen_files.add(fp)
        parser = get_parser_for_file_ts(fp)
        if parser is None:
            continue
        try:
            with open(fp, 'rb') as f:
                source = f.read()
            tree = parser.parse(source)
        except Exception:
            continue
        # Traverse function_definition nodes and match identifier
        stack = [tree.root_node]
        while stack:
            node = stack.pop()
            if node.type == 'function_definition':
                decl = node.child_by_field_name('declarator') if hasattr(node, 'child_by_field_name') else None
                name = None
                if decl is not None:
                    name = extract_identifier_name_ts(decl, source)
                else:
                    name = extract_identifier_name_ts(node, source)
                if name == function_name:
                    # find guid(s) that point to this file and whose stored name matches
                    for g, inf in function_infos.items():
                        if inf[1] == fp and inf[0] == name:
                            return g
            named_children = getattr(node, 'named_children', [])
            if named_children:
                for c in named_children:
                    stack.append(c)
    return None

def find_enum_ts(enum_name, abs_fp, line_number):
    """Find enum using Tree-sitter"""
    parser = get_parser_for_file_ts(abs_fp)
    if parser is None:
        return ""
    
    try:
        with open(abs_fp, 'rb') as f:
            source = f.read()
        tree = parser.parse(source)
    except Exception:
        return ""
    
    target = find_node_by_name_ts(tree.root_node, enum_name, ['enum_specifier'], line_number)
    if target:
        return extract_node_text_ts(source, target)
    return ""


def find_struct_ts(struct_name, abs_fp, line_number):
    """Find struct using Tree-sitter"""
    parser = get_parser_for_file_ts(abs_fp)
    if parser is None:
        return ""
    
    try:
        with open(abs_fp, 'rb') as f:
            source = f.read()
        tree = parser.parse(source)
    except Exception:
        return ""
    
    target = find_node_by_name_ts(tree.root_node, struct_name, ['struct_specifier'], line_number)
    if target:
        return extract_node_text_ts(source, target)
    return ""


def find_class_ts(class_name, abs_fp, line_number):
    """Find class using Tree-sitter"""
    parser = get_parser_for_file_ts(abs_fp)
    if parser is None:
        return ""
    
    try:
        with open(abs_fp, 'rb') as f:
            source = f.read()
        tree = parser.parse(source)
    except Exception:
        return ""
    
    target = find_node_by_name_ts(tree.root_node, class_name, ['class_specifier'], line_number)
    if target:
        return extract_node_text_ts(source, target)
    return ""


def find_function_ts(function_name, abs_fp, line_number):
    """Find function using Tree-sitter"""
    parser = get_parser_for_file_ts(abs_fp)
    if parser is None:
        return ""
    
    try:
        with open(abs_fp, 'rb') as f:
            source = f.read()
        tree = parser.parse(source)
    except Exception:
        return ""
    
    target = find_node_by_name_ts(tree.root_node, function_name, ['function_definition', 'function_declarator'], line_number)
    if target:
        return extract_node_text_ts(source, target)
    return ""


def find_node_by_name_ts(root_node, target_name, node_types, line_number):
    """Generic helper to find nodes by name and type using Tree-sitter"""
    candidates = []
    
    def walk_tree(node):
        if node.type in node_types:
            # Extract the name from the node
            name = extract_name_from_node_ts(node)
            if name == target_name:
                candidates.append(node)
        
        named_children = getattr(node, 'named_children', [])
        if named_children:
            for child in named_children:
                walk_tree(child)
    
    walk_tree(root_node)
    
    if not candidates:
        return None
        
    # Prefer node closest to the specified line
    if line_number > 0:
        candidates.sort(key=lambda n: abs(n.start_point[0] + 1 - line_number))
    
    return candidates[0]


def extract_name_from_node_ts(node):
    """Extract the name/identifier from a Tree-sitter node"""
    # Look for type_identifier or identifier children
    named_children = getattr(node, 'named_children', [])
    if named_children:
        for child in named_children:
            if child.type in ('type_identifier', 'identifier'):
                return child.text.decode('utf-8') if hasattr(child, 'text') else ""
            # Recursive search in declarators
            if child.type in ('function_declarator', 'declarator'):
                name = extract_name_from_node_ts(child)
                if name:
                    return name
    return ""


def extract_node_text_ts(source_bytes, node):
    """Extract text content from a Tree-sitter node with line numbers"""
    try:
        start_byte = node.start_byte
        end_byte = node.end_byte
        text = source_bytes[start_byte:end_byte].decode('utf-8')
        
        # Add line numbers
        start_line = node.start_point[0] + 1
        lines = text.split('\n')
        numbered_lines = []
        for i, line in enumerate(lines):
            line_num = start_line + i
            numbered_lines.append(f"[{line_num}]: {line}")
        
        return '\n'.join(numbered_lines)
    except Exception:
        return ""

def _format_multiple_functions_source_code_ts(candidates):
    """
    Format the source code of multiple functions using Tree-sitter.
    Groups functions by their file path, sorts files alphabetically,
    and then sorts functions within each file by their starting line number.
    
    Args:
        candidates: List of (func_name, file_path, start_line, snippet) tuples
        
    Returns:
        String with formatted source code, with # filename headers
    """
    if not candidates:
        return ""
    
    file_functions = collections.defaultdict(list)
    for func_name, file_path, start_line, snippet in candidates:
        if file_path and snippet:
            file_functions[file_path].append((func_name, start_line, snippet))
    
    if not file_functions:
        return ""
    
    parts = []
    for filepath in sorted(file_functions.keys()):
        filename = os.path.basename(filepath)
        funcs_with_lines = file_functions[filepath]
        funcs_with_lines.sort(key=lambda x: x[1])  # Sort by start_line
        
        parts.append(f"/* inside file={filename} */")
        
        for _, _, snippet in funcs_with_lines:
            if snippet:
                parts.append(snippet)
                if len(funcs_with_lines) > 1:
                    parts.append("")  # Empty line between functions in same file
    
    return "\n".join(parts).rstrip()


def get_source_code_fun_list_ts(functionName_list):
    """
    Return source code for multiple functions, grouped by filename.
            
    :param functionName_list: List of (function_name, file_path) pairs
    :return: String with format:
                # filename1
                lineNum funcA source code
                ...
                # filename2
                lineNum funcB source code
                ...
    """
    if Parser is None:
        return ""
    if not functionName_list:
        return ""

    candidates = []
    seen = set()

    # Group function names by file path
    path_to_functions = collections.defaultdict(list)
    for func_name, file_path in functionName_list:
        if func_name and file_path:
            path_to_functions[file_path].append(func_name)

    # Process each unique file path
    for file_path, func_names in path_to_functions.items():
        if not os.path.isfile(file_path):
            continue
        
        try:
            with open(file_path, 'rb') as f:
                src = f.read()
        except Exception:
            continue
            
        parser = get_parser_for_file_ts(file_path)
        if parser is None:
            continue
            
        try:
            tree = parser.parse(src)
        except Exception:
            continue

        # traverse function_definition nodes
        stack = [tree.root_node]
        while stack:
            node = stack.pop()
            if node.type == 'function_definition':
                # try to extract name
                name = extract_name_from_node_ts(node)
                if not name:
                    name = extract_identifier_name_ts(node, src)
                if not name:
                    # skip unnamed (possibly lambdas)
                    pass
                else:
                    for func_name in func_names:
                        if func_name and func_name in name:
                            key = (os.path.abspath(file_path), name, node.start_point[0])
                            if key in seen:
                                break
                            seen.add(key)
                            snippet = extract_node_text_ts(src, node)
                            start_line = node.start_point[0] + 1
                            candidates.append((name, os.path.abspath(file_path), start_line, snippet))
                            break
            named_children = getattr(node, 'named_children', [])
            if named_children:
                for c in named_children:
                    stack.append(c)

    if not candidates:
        return ""

    return _format_multiple_functions_source_code_ts(candidates)