def generate(**params):
    """
    Returns: (input_bytes, used_params_dict)
    Sampling rules:
      - If params[k] is a dict with {"type": ...}, SAMPLE a concrete value.
      - If params[k] is a scalar, USE it as-is.
      - Seed randomness with params.get("seed").
      - Record the resolved concrete values in used_params_dict.
    
    CRITICAL: For string types, sample like this:
    if isinstance(params["data"], dict) and params["data"]["type"] == "string":
        data = "sampled_string_value"  # SAMPLE concrete value
        # NOT: data = params["data"]   # Wrong - don't use the dict!
    """
    import random
    random.seed(params.get("seed", 0))
    used_params = {"seed": params.get("seed", 0)}

    if isinstance(params["data"], dict) and params["data"]["type"] == "string":
        # Sample a concrete string value from the parameter space
        data = "<?xml version='1.0' encoding='ISO-8859-1'?>" # Default
        used_params["data"] = data
    else:
        data = params["data"]
        used_params["data"] = data

    if isinstance(params["option_value"], dict) and params["option_value"]["type"] == "int_range":
        option_value = random.randint(params["option_value"]["min"], params["option_value"]["max"])
        used_params["option_value"] = option_value
    else:
        option_value = params["option_value"]
        used_params["option_value"] = option_value

    payload = data.encode('utf-8', errors='ignore')
    return payload, used_params