# ===============================
# libclang-based helpers
# ===============================
import re
try:
    from clang.cindex import CursorKind  # type: ignore
except ImportError:
    CursorKind = None
def try_load_clang():
    """
    Lazy import libclang (clang.cindex). Return module or None if unavailable.
    """
    try:
        from clang import cindex  # type: ignore
        return cindex
    except Exception:
        return None


def parse_translation_unit(filename, args=None, detailed=True):
    """
    Parse a C/C++ file into a TranslationUnit using libclang. Returns (tu, index) or (None, None).
    """
    cindex = try_load_clang()
    if cindex is None:
        return None, None
    try:
        index = cindex.Index.create()
        parse_opts = 0
        if detailed:
            parse_opts |= cindex.TranslationUnit.PARSE_DETAILED_PROCESSING_RECORD
        tu = index.parse(filename, args=args or ['-x', 'c++', '-std=c++11'], options=parse_opts)
        return tu, index
    except Exception:
        return None, None


def collect_macro_definitions(tu, target_file_abs):
    """
    Collect macro definitions in the translation unit.
    Returns dict: name -> { 'params': [..] or None, 'body': str }
    Only collects macros defined in the same file as target_file_abs (best-effort for tests).
    """
    macros = {}
    if tu is None or CursorKind is None:
        return macros
    for cursor in tu.cursor.walk_preorder():
        if not hasattr(CursorKind, 'MACRO_DEFINITION') or cursor.kind != getattr(CursorKind, 'MACRO_DEFINITION', None):
            continue
        if not cursor.location.file:
            continue
        # Collect macros from any included file in the TU (headers or source)
        tokens = list(cursor.get_tokens())
        if not tokens:
            continue
        name = tokens[0].spelling
        params = None
        body_tokens = []
        # Detect function-like macro: name '(' ... ')'
        i = 1
        if i < len(tokens) and tokens[i].spelling == '(':
            params = []
            paren = 0
            param_tokens = []
            while i < len(tokens):
                tok = tokens[i]
                if tok.spelling == '(':
                    paren += 1
                elif tok.spelling == ')':
                    paren -= 1
                    if paren == 0:
                        # params collected in param_tokens (comma separated identifiers)
                        # Convert to simple list of identifiers
                        cur = []
                        for pt in param_tokens:
                            if pt.spelling == ',':
                                if cur:
                                    params.append(''.join(t.spelling for t in cur).strip())
                                    cur = []
                            else:
                                cur.append(pt)
                        if cur:
                            params.append(''.join(t.spelling for t in cur).strip())
                        body_tokens = tokens[i+1:]
                        i = len(tokens)
                        break
                else:
                    param_tokens.append(tok)
                i += 1
            if not body_tokens and i < len(tokens):
                # Empty parameter list case like FOO()
                body_tokens = tokens[i:]
        else:
            # Object-like macro
            body_tokens = tokens[1:]

        body = ' '.join(t.spelling for t in body_tokens).strip()
        macros[name] = {'params': params, 'body': body}
    return macros


def collect_macros_from_source_file(filepath):
    """
    Lightweight fallback macro collector using regex over source file for lines like:
      #define NAME(args) body
      #define NAME body
    Returns dict compatible with collect_macro_definitions.
    """
    macros = {}
    try:
        pattern = re.compile(r'^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(([^)]*)\))?\s*(.*)$')
        with open(filepath, 'r') as f:
            for line in f:
                m = pattern.match(line)
                if not m:
                    continue
                name = m.group(1)
                params_group = m.group(3)
                body = (m.group(4) or '').strip()
                if params_group is not None:
                    params = [p.strip() for p in params_group.split(',') if p.strip()]
                else:
                    params = None
                macros[name] = {'params': params, 'body': body}
    except Exception:
        pass
    return macros


def extract_call_arguments_from_source(source_text, name_pos):
    """
    Given source_text and starting index where macro/function name begins,
    return (args_list, end_pos). If no parentheses found, returns ([], name_pos).
    Handles balanced parentheses and allows arguments to span until the matching ')'.
    """
    i = name_pos
    max_search_chars = 1000  # Safety limit to prevent infinite loops
    search_count = 0
    
    # seek first '('
    while i < len(source_text) and source_text[i] != '(' and search_count < max_search_chars:
        i += 1
        search_count += 1
    if i >= len(source_text) or source_text[i] != '(' or search_count >= max_search_chars:
        return [], name_pos
    i += 1
    paren = 1
    arg = ''
    args = []
    parse_count = 0
    max_parse_chars = 5000  # Safety limit for argument parsing
    
    while i < len(source_text) and paren > 0 and parse_count < max_parse_chars:
        ch = source_text[i]
        if ch == '(':
            paren += 1
            arg += ch
        elif ch == ')':
            paren -= 1
            if paren == 0:
                # end of args
                args.append(arg.strip())
                i += 1
                break
            else:
                arg += ch
        elif ch == ',' and paren == 1:
            args.append(arg.strip())
            arg = ''
        else:
            arg += ch
        i += 1
        parse_count += 1
    
    # Safety check: if we hit the limit, return what we have
    if parse_count >= max_parse_chars:
        if arg.strip():
            args.append(arg.strip())
    
    return [a for a in args if a != ''], i


def expand_function_like_macros(text, macro_defs, max_depth=3):
    """
    Expand function-like macro invocations appearing in text using simple parsing.
    """
    if not text:
        return text
    for _ in range(max_depth):
        changed = False
        original_text_len = len(text)
        for name, info in macro_defs.items():
            params = info['params']
            if params is None:
                continue
            # search for name occurrence followed by '(' possibly with spaces
            search_pos = 0
            search_iterations = 0
            max_search_iterations = 100  # Prevent excessive searching
            
            while search_iterations < max_search_iterations:
                idx = text.find(name, search_pos)
                if idx < 0:
                    break
                j = idx + len(name)
                # skip whitespace with safety limit
                whitespace_count = 0
                while j < len(text) and text[j].isspace() and whitespace_count < 50:
                    j += 1
                    whitespace_count += 1
                if j >= len(text) or text[j] != '(':
                    search_pos = idx + 1
                    search_iterations += 1
                    continue
                args, end_pos = extract_call_arguments_from_source(text, j)
                if end_pos <= j:
                    search_pos = idx + 1
                    search_iterations += 1
                    continue
                expanded = substitute_params(info['body'], params, args)
                # Prevent text explosion
                if len(expanded) > 10000:  # Limit expansion size
                    search_pos = idx + 1
                    search_iterations += 1
                    continue
                # replace from idx to end_pos with expanded
                text = text[:idx] + expanded + text[end_pos:]
                changed = True
                # continue after the replacement
                search_pos = idx + len(expanded)
                search_iterations += 1
                
                # Safety check: prevent text from growing too large
                if len(text) > original_text_len * 3:  # Max 3x growth
                    break
        if not changed:
            break
    return text


def expand_object_macros(text, macro_defs, max_depth=3):
    """
    Recursively expand object-like macros in text using simple identifier replacement.
    """
    if not text:
        return text
    for _ in range(max_depth):
        changed = False
        original_text_len = len(text)
        for name, info in macro_defs.items():
            if info['params'] is not None:
                continue
            # Prevent expansion of very large bodies
            if len(info['body']) > 5000:
                continue
            # avoid replacing when followed by '(' which indicates function-like use
            pattern = r"\b" + re.escape(name) + r"\b(?!\s*\()"
            new_text, n = re.subn(pattern, info['body'], text, count=10)  # Limit replacements
            if n > 0:
                text = new_text
                changed = True
                # Safety check: prevent text from growing too large
                if len(text) > original_text_len * 3:  # Max 3x growth
                    break
        if not changed:
            break
    return text


def substitute_params(body, params, args):
    """
    Substitute parameter names in body with the corresponding args (string replacement on token boundaries).
    """
    if not params:
        # Fallback: common single-parameter macro name 'x'
        if args:
            try:
                return re.sub(r"\bx\b", args[0], body)
            except Exception:
                return body
        return body
    mapping = {}
    for idx, p in enumerate(params):
        if idx < len(args):
            mapping[p] = args[idx]
    result = body
    for p, a in mapping.items():
        pattern = r"\\b" + re.escape(p) + r"\\b"
        result = re.sub(pattern, a, result)
    # Extra robustness: common placeholder 'x'
    if args:
        try:
            result = re.sub(r"\bx\b", args[0], result)
        except Exception:
            pass
    return result


# ===============================
# libclang AST traversal helpers  
# ===============================

def find_enum_libclang(abs_fp, enum_name, line_number, logger=None):
    """Find enum using libclang"""
    import os
    tu, _ = parse_translation_unit(abs_fp, args=['-x', 'c++', '-std=c++11'], detailed=True)
    if tu is None or CursorKind is None:
        if logger:
            logger.warning("libclang unavailable or failed to parse; cannot find enum")
        return ''
    
    cursor_kinds = [getattr(CursorKind, 'ENUM_DECL')] if hasattr(CursorKind, 'ENUM_DECL') else []
    target = find_cursor_by_kind_and_name(tu, cursor_kinds, enum_name, abs_fp, line_number, logger) if cursor_kinds else None
    if target:
        return extract_cursor_text(target, abs_fp, logger)
    
    if logger:
        logger.warning(f"No enum '{enum_name}' found at {os.path.basename(abs_fp)}:{line_number}")
    return ""


def find_struct_libclang(abs_fp, struct_name, line_number, logger=None):
    """Find struct using libclang"""
    import os
    tu, _ = parse_translation_unit(abs_fp, args=['-x', 'c++', '-std=c++11'], detailed=True)
    if tu is None or CursorKind is None:
        if logger:
            logger.warning("libclang unavailable or failed to parse; cannot find struct")
        return ''
    
    cursor_kinds = [getattr(CursorKind, 'STRUCT_DECL')] if hasattr(CursorKind, 'STRUCT_DECL') else []
    target = find_cursor_by_kind_and_name(tu, cursor_kinds, struct_name, abs_fp, line_number, logger) if cursor_kinds else None
    if target:
        return extract_cursor_text(target, abs_fp, logger)
    
    if logger:
        logger.warning(f"No struct '{struct_name}' found at {os.path.basename(abs_fp)}:{line_number}")
    return ""


def find_class_libclang(abs_fp, class_name, line_number, logger=None):
    """Find class using libclang"""
    import os
    tu, _ = parse_translation_unit(abs_fp, args=['-x', 'c++', '-std=c++11'], detailed=True)
    if tu is None or CursorKind is None:
        if logger:
            logger.warning("libclang unavailable or failed to parse; cannot find class")
        return ''
    
    cursor_kinds = [getattr(CursorKind, 'CLASS_DECL')] if hasattr(CursorKind, 'CLASS_DECL') else []
    target = find_cursor_by_kind_and_name(tu, cursor_kinds, class_name, abs_fp, line_number, logger) if cursor_kinds else None
    if target:
        return extract_cursor_text(target, abs_fp, logger)
    
    if logger:
        logger.warning(f"No class '{class_name}' found at {os.path.basename(abs_fp)}:{line_number}")
    return ""


def find_function_libclang(abs_fp, function_name, line_number, logger=None):
    """Find function using libclang"""
    import os
    tu, _ = parse_translation_unit(abs_fp, args=['-x', 'c++', '-std=c++11'], detailed=True)
    if tu is None or CursorKind is None:
        if logger:
            logger.warning("libclang unavailable or failed to parse; cannot find function")
        return ''
    
    cursor_kinds = []
    if hasattr(CursorKind, 'FUNCTION_DECL'):
        cursor_kinds.append(getattr(CursorKind, 'FUNCTION_DECL'))
    if hasattr(CursorKind, 'CXX_METHOD'):
        cursor_kinds.append(getattr(CursorKind, 'CXX_METHOD'))
    target = find_cursor_by_kind_and_name(tu, cursor_kinds, function_name, abs_fp, line_number, logger) if cursor_kinds else None
    if target:
        return extract_cursor_text(target, abs_fp, logger)
    
    if logger:
        logger.warning(f"[LIBCLANG] No function '{function_name}' found at {os.path.basename(abs_fp)}:{line_number}")
    return ""


def find_cursor_by_kind_and_name(tu, cursor_kinds, target_name, abs_fp, line_number, logger=None):
    """Generic helper to find cursors by kind and name using libclang"""
    import os
    candidates = []
    
    # First, look near the specified line
    for cursor in tu.cursor.walk_preorder():
        if not cursor.location.file:
            continue
        if cursor.kind not in cursor_kinds:
            continue
        if cursor.spelling != target_name:
            continue
        
        cursor_file = os.path.abspath(cursor.location.file.name)
        if cursor_file == abs_fp and abs(cursor.location.line - line_number) <= 2:
            return cursor
        elif cursor_file == abs_fp:
            candidates.append(cursor)
    
    # Fallback: search in entire translation unit (including headers)
    if not candidates:
        for cursor in tu.cursor.walk_preorder():
            if not cursor.location.file:
                continue
            if cursor.kind not in cursor_kinds:
                continue
            if cursor.spelling != target_name:
                continue
            candidates.append(cursor)
    
    if candidates:
        # Prefer the one closest to the specified line in the same file
        same_file_candidates = [c for c in candidates 
                              if os.path.abspath(c.location.file.name) == abs_fp]
        if same_file_candidates:
            same_file_candidates.sort(key=lambda c: abs(c.location.line - line_number))
            return same_file_candidates[0]
        else:
            return candidates[0]
    
    return None


def extract_cursor_text(cursor, abs_fp, logger=None):
    """Extract text content from a libclang cursor with line numbers"""
    try:
        def_file = cursor.location.file.name if cursor.location.file else abs_fp
        
        with open(def_file, 'r') as f:
            src = f.read()
        
        # Get the extent
        start_line = cursor.extent.start.line
        end_line = cursor.extent.end.line
        start_col = cursor.extent.start.column
        end_col = cursor.extent.end.column
        
        # Split source into lines
        lines = src.split('\n')
        
        if start_line > len(lines) or start_line < 1:
            if logger:
                logger.warning(f"Invalid start line {start_line} for file with {len(lines)} lines")
            return ""
        
        # Extract the text spanning multiple lines
        if start_line == end_line:
            # Single line
            if start_line <= len(lines):
                line = lines[start_line - 1]  # Convert to 0-based
                text = line[start_col - 1:end_col - 1] if end_col > start_col else line[start_col - 1:]
                return f"[{start_line}]: {text}"
        else:
            # Multiple lines
            extracted_lines = []
            for line_num in range(start_line, min(end_line + 1, len(lines) + 1)):
                if line_num <= len(lines):
                    line = lines[line_num - 1]  # Convert to 0-based
                    if line_num == start_line and start_col > 1:
                        # First line: start from start_col
                        line = line[start_col - 1:]
                    elif line_num == end_line and end_col > 1:
                        # Last line: end at end_col
                        line = line[:end_col - 1]
                    extracted_lines.append(f"[{line_num}]: {line}")
            
            return '\n'.join(extracted_lines)
        
        return ""
    except Exception as e:
        if logger:
            logger.warning(f"Failed to extract cursor text: {e}")
        return ""
