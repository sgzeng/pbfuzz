import logging
import os
import re
import shlex
import sys
from typing import Dict, Any, Tuple, List, Optional

import utils
from enum import Enum
from pathlib import Path

# Provider categorization
class LLMPROVIDER(Enum):
    GEMINI = "gemini"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    QWEN = "qwen"
    CURSOR = "cursor"

class LLMModel(Enum):
    # Google Gemini models
    GEMINI_2_5_FLASH = "gemini-2.5-flash"
    GEMINI_2_5_PRO = "gemini-2.5-pro"
    GEMINI_2_0_FLASH = "gemini-2.0-flash"
    GEMINI_2_0_FLASH_LITE = "gemini-2.0-flash-lite"
    # OpenAI GPT models
    GPT_3_5_TURBO = "gpt-3.5-turbo"
    GPT_3_5_TURBO_16K = "gpt-3.5-turbo-16k"
    GPT_4 = "gpt-4"
    GPT_4_32K = "gpt-4-32k"
    GPT_4_O = "gpt-4o"
    GPT_4_O_MINI = "gpt-4o-mini"
    GPT_4_1 = "gpt-4.1"
    GPT_4_1_MINI = "gpt-4.1-mini"
    GPT_4_1_NANO = "gpt-4.1-nano"
    GPT_4_5 = "gpt-4.5"
    GPT_5 = "gpt-5"
    GPT_5_MINI = "gpt-5-mini"
    GPT_5_NANO = "gpt-5-nano"
    O1 = "o1"
    O1_MINI = "o1-mini"
    O1_PRO = "o1-pro"
    O3 = "o3"
    O3_MINI = "o3-mini"
    O3_PRO = "o3-pro"
    O4_MINI = "o4-mini"
    # Anthropic Claude models
    CLAUDE_3_5_HAIKU = "claude-3.5-haiku-latest"
    CLAUDE_3_5_SONNET = "claude-3-5-sonnet-latest"
    CLAUDE_3_5_SONNETV2 = "claude-3-5-sonnet-v2"
    CLAUDE_3_7_SONNET = "claude-3.7-sonnet-latest"
    CLAUDE_SONNET_4 = "claude-sonnet-4"
    CLAUDE_OPUS_4 = "claude-opus-4"
    # Ali qwen models
    QWEN_3 = "qwen3-coder"

def get_provider(model: LLMModel) -> LLMPROVIDER:
    if model.name.startswith("GEMINI"):
        return LLMPROVIDER.GEMINI
    if model.name.startswith("GPT") or  model.name.startswith("O"):
        return LLMPROVIDER.OPENAI
    if model.name.startswith("CLAUDE"):
        return LLMPROVIDER.ANTHROPIC
    if model.name.startswith("QWEN"):
        return LLMPROVIDER.QWEN
    raise ValueError(f"Unknown provider for model {model}")

class LLMClient:
    
    def __init__(self, config, prompt_engine):
        self.config = config
        self.logger = logging.getLogger(self.__class__.__qualname__)
        self.installed_libs = set()
        self.prompt_engine = prompt_engine
        # load program‐specific knowledge
        self.knowledge = utils.load_knowledge()
        self.python_file_dump_pattern = re.compile(
            r"""with\s+open\(\s*      # with open(
                ['"]([^'"]+)['"]     #   capture filename
                \s*,                 #   comma
            """, re.VERBOSE)
        # Create history directory if chat logging is enabled
        if self.config.chat_log:
            utils.mkdir(self.config.output_dir / "history")

        # Determine provider
        self.provider = get_provider(self.config.llm_model)
        # Lazy client initialization
        self._gemini_client = None
        self._openai_client = None
        self._claude_client = None
    
        # State management for fuzzing loop
        self.current_round = 0
        self.chat_history = []  # Store complete conversation history with all data
        self.current_generator_code = None
        # Initialize request handler lazy loading
        self._request_handler = None
        # Initialize protocol parser
        self._protocol_parser = None
        
        # Cache for fixed generator code
        self._last_fixed_generator_code = None


    def _generate_llm_response(self, prompt: str) -> str:
        # Future option chat API usage:
        # chat = self.client.chats.create...
        if self.provider == LLMPROVIDER.GEMINI:
            from google.genai import types
            client = self._get_gemini_client()
            contents = [ types.Content(role="user", parts=[types.Part(text=prompt)]),
                         types.Content(role="model", parts=[types.Part(text='```')]) ]
            resp = client.models.generate_content(
                model=self.config.llm_model.value,
                contents=contents,  # type: ignore[arg-type]
                config=types.GenerateContentConfig(
                    system_instruction=self.prompt_engine.get_role(),
                    temperature=self.config.temperature
                ),
            )
            return resp.text or ""
        elif self.provider == LLMPROVIDER.OPENAI:
            client = self._get_openai_client()
            
            # Check if this is a GPT-5 model to use new Responses API
            if self.config.llm_model.value.startswith("gpt-5"):
                return self._generate_gpt5_response(client, prompt)
            else:
                # Use traditional Chat Completions API for other models
                messages = [
                    {"role": "system",    "content": self.prompt_engine.get_role()},
                    {"role": "user",      "content": prompt},
                    {"role": "assistant", "content": "```"}
                ]
                
                # Prepare API parameters with temperature support
                api_params = {
                    "model": self.config.llm_model.value,
                    "messages": messages,  # type: ignore
                    "temperature": self.config.temperature
                }
                
                # Add reasoning effort for thinking models (o1, o3 series)
                if (self.config.llm_model.value.startswith(("o1", "o3")) and 
                    self.config.reasoning_effort != "auto"):
                    # Note: o1/o3 models may have different parameter names
                    # This is a placeholder for when OpenAI officially supports reasoning effort
                    api_params["reasoning_effort"] = self.config.reasoning_effort
                
                resp = client.chat.completions.create(**api_params)
                return resp.choices[0].message.content or ""
        elif self.provider == LLMPROVIDER.ANTHROPIC:
            client = self._get_claude_client()
            # Anthropic API format - system message is separate parameter
            messages = [
                {"role": "user",      "content": prompt},
                {"role": "assistant", "content": "```"}
            ]
            resp = client.messages.create(
                model=self.config.llm_model.value,
                system=self.prompt_engine.get_role(),
                messages=messages,  # type: ignore
                max_tokens=4096,
                temperature=self.config.temperature
            )
            # Anthropic returns a list of content blocks
            if resp.content and len(resp.content) > 0:
                return resp.content[0].text if hasattr(resp.content[0], 'text') else str(resp.content[0])  # type: ignore
            return ""
        else:
            raise ValueError(f"Unsupported provider {self.provider}")
    
    def _generate_gpt5_response(self, client, prompt: str) -> str:
        """
        Generate response using GPT-5 Responses API with enhanced features.
        
        Features implemented:
        - Dynamic reasoning effort: low (round 1) -> medium (round 2) -> high (round 3+)
        - Low verbosity for strict protocol adherence
        - System instruction integration
        """
        # Determine reasoning effort based on configuration and current round
        if self.config.reasoning_effort == "auto":
            # Dynamic reasoning effort based on round number
            if self.current_round <= 1:
                reasoning_effort = "low"
            elif self.current_round == 2:
                reasoning_effort = "medium"
            else:
                reasoning_effort = "high"
        else:
            # Use fixed reasoning effort from configuration
            reasoning_effort = self.config.reasoning_effort
        
        # Combine system role with user prompt for GPT-5
        # GPT-5 Responses API uses 'input' parameter instead of messages
        system_role = self.prompt_engine.get_role()
        full_input = f"System: {system_role}\n\nUser: {prompt}\n\nAssistant: ```"
        
        try:
            # Use GPT-5 Responses API with new parameters
            resp = client.responses.create(
                model=self.config.llm_model.value,
                input=full_input,
                reasoning={
                    "effort": reasoning_effort
                },
                text={
                    "verbosity": "low"  # For strict protocol adherence
                }
            )
            
            self.logger.debug(f"GPT-5 response generated with reasoning effort: {reasoning_effort}")
            return resp.output_text or ""
            
        except Exception as e:
            # Fallback to Chat Completions API if Responses API fails
            self.logger.warning(f"GPT-5 Responses API failed, falling back to Chat Completions: {e}")
            messages = [
                {"role": "system", "content": self.prompt_engine.get_role()},
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": "```"}
            ]
            # Prepare fallback API parameters
            fallback_params = {
                "model": self.config.llm_model.value,
                "messages": messages,  # type: ignore
                "temperature": self.config.temperature
            }
            
            # Add GPT-5 specific parameters if supported
            if hasattr(client.chat.completions, 'verbosity'):
                fallback_params["verbosity"] = "low"
            
            resp = client.chat.completions.create(**fallback_params)
            return resp.choices[0].message.content or ""
    
    def _extract_libs(self, code_str_raw):
        libs = []
        pattern = re.compile(
            r'(?m)#\s*pip(?:3)?\s+install\s+([\s\S]*?)(?=(?:\n#)|$)',
            re.IGNORECASE
        )
        for match in pattern.finditer(code_str_raw):
            cmd_args = match.group(1)
            try:
                # Use shlex to handle quotes, line continuations, and spacing correctly
                tokens = shlex.split(cmd_args, comments=True)
            except ValueError:
                # Fallback if shlex fails (e.g., bad quotes)
                tokens = cmd_args.replace("\\\n", " ").split()
            for tok in tokens:
                # Skip flags like --no-deps, -U, --upgrade-strategy=only-if-needed
                if tok.startswith('-'):
                    continue
                # Accept valid package names, optionally with version constraints
                if (re.match(r'^[A-Za-z0-9_.\-]+(?:[<=>!~]+.+)?$', tok) 
                    and tok not in self.installed_libs):
                    libs.append(tok)
                    self.installed_libs.add(tok)

        return list(set(libs))

    def _get_gemini_client(self):
        import google.genai as genai
        if self._gemini_client is None:
            api_key = (
                os.getenv("GEMINI_API_KEY")
                or os.getenv("GOOGLE_API_KEY")
                or os.getenv("GOOGLE_GENERATIVEAI_API_KEY")
            )
            if not api_key:
                sys.exit("Please set GEMINI_API_KEY (or GOOGLE_API_KEY) in your environment.")
            self._gemini_client = genai.Client(api_key=api_key)
        return self._gemini_client

    def _get_openai_client(self):
        from openai import OpenAI
        if self._openai_client is None:
            openai_api_key = os.getenv("OPENAI_API_KEY")
            if not openai_api_key:
                sys.exit("Please set OPENAI_API_KEY in your environment.")
            self._openai_client = OpenAI(api_key=openai_api_key)
        return self._openai_client

    def _get_claude_client(self):
        from anthropic import Anthropic
        if self._claude_client is None:
            anthropic_api_key = os.getenv("ANTHROPIC_API_KEY")
            if not anthropic_api_key:
                sys.exit("Please set ANTHROPIC_API_KEY in your environment.")
            self._claude_client = Anthropic(api_key=anthropic_api_key)
        return self._claude_client
