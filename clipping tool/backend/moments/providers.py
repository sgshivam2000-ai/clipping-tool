"""Provider adapters. Credentials stay on the server; there is no fallback model."""

from __future__ import annotations

import json
import os
import socket
from dataclasses import dataclass, field
from typing import Protocol
from urllib import error, request
from urllib.parse import urlparse


class MomentError(Exception):
    def __init__(self, message: str, code: str = "analysis_failed", http_status: int = 422):
        super().__init__(message)
        self.code = code
        self.http_status = http_status


@dataclass(frozen=True)
class ProviderConfig:
    provider: str
    model: str
    base_url: str
    api_key: str = field(repr=False)
    timeout: int = 180
    max_tokens: int = 4096
    response_format: str = "json_schema"
    context_tokens: int = 16384


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
        if minimum <= value <= maximum:
            return value
    except ValueError:
        pass
    raise MomentError(f"{name} must be an integer between {minimum} and {maximum}.", "configuration_error", 503)


def load_provider_config() -> ProviderConfig:
    provider = os.environ.get("CLIPFORGE_LLM_PROVIDER", "").strip().lower()
    if not provider:
        raise MomentError(
            "No LLM provider is configured. Set CLIPFORGE_LLM_PROVIDER and CLIPFORGE_LLM_MODEL "
            "on the backend. Cloud providers also need CLIPFORGE_LLM_API_KEY. No analysis has been run.",
            "configuration_error", 503,
        )
    if provider not in PROVIDERS:
        raise MomentError("CLIPFORGE_LLM_PROVIDER must be openai, openai_compatible, or ollama.", "configuration_error", 503)
    model = os.environ.get("CLIPFORGE_LLM_MODEL", "").strip()
    if not model or len(model) > 200 or any(ord(c) < 32 for c in model):
        raise MomentError("Set CLIPFORGE_LLM_MODEL to a valid model name supported by your provider.", "configuration_error", 503)
    key = os.environ.get("CLIPFORGE_LLM_API_KEY", "").strip()
    if provider == "openai" and not key:
        raise MomentError("CLIPFORGE_LLM_API_KEY is required for OpenAI.", "configuration_error", 503)
    default_url = {"openai": "https://api.openai.com/v1", "ollama": "http://localhost:11434"}.get(provider, "")
    base_url = os.environ.get("CLIPFORGE_LLM_BASE_URL", default_url).strip().rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise MomentError("CLIPFORGE_LLM_BASE_URL must be an HTTP(S) base URL without credentials, query, or fragment.", "configuration_error", 503)
    if parsed.scheme == "http" and key and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise MomentError("Use HTTPS for a remote LLM endpoint that receives an API key.", "configuration_error", 503)
    response_format = os.environ.get("CLIPFORGE_LLM_RESPONSE_FORMAT", "json_schema").strip()
    if response_format not in ("json_schema", "json_object"):
        raise MomentError("CLIPFORGE_LLM_RESPONSE_FORMAT must be json_schema or json_object.", "configuration_error", 503)
    return ProviderConfig(
        provider, model, base_url, key,
        env_int("CLIPFORGE_LLM_TIMEOUT_S", 180, 5, 900),
        env_int("CLIPFORGE_LLM_MAX_OUTPUT_TOKENS", 4096, 256, 16384),
        response_format,
        env_int("CLIPFORGE_LLM_CONTEXT_TOKENS", 16384, 4096, 131072),
    )


def parse_json(text: str) -> dict:
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result

    try:
        result = json.loads(text, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if not isinstance(result, dict):
            raise ValueError("Expected JSON object")
        return result
    except (ValueError, TypeError):
        raise MomentError("The LLM returned invalid JSON. Retry analysis or use a model with structured-output support.", "invalid_provider_response") from None


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def post_json(config: ProviderConfig, path: str, payload: dict) -> dict:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    req = request.Request(config.base_url + path, data=json.dumps(payload).encode(), headers=headers, method="POST")
    try:
        # Never forward a bearer credential to a redirect target.
        with request.build_opener(NoRedirect()).open(req, timeout=config.timeout) as response:
            body = response.read(2_000_001)
        if len(body) > 2_000_000:
            raise MomentError("The LLM response exceeded the safety size limit.", "invalid_provider_response")
        return parse_json(body.decode("utf-8"))
    except error.HTTPError as exc:
        status = exc.code
        exc.close()
        messages = {
            400: "The LLM rejected the request. Check model and structured-output compatibility.",
            401: "The LLM provider rejected the API key. Check the backend credentials.",
            403: "The LLM provider denied access. Check the API key and model permissions.",
            404: "The LLM endpoint or model was not found. Check the backend base URL and model name.",
            429: "The LLM provider rate limit or account quota was reached. Retry later.",
        }
        # Remote bodies and exception strings can echo secrets or transcript text.
        raise MomentError(messages.get(status, f"The LLM provider returned HTTP {status}. Retry later."), "provider_http_error", 502) from None
    except (TimeoutError, socket.timeout):
        raise MomentError("The LLM request timed out. Retry or increase CLIPFORGE_LLM_TIMEOUT_S.", "provider_timeout", 504) from None
    except (error.URLError, OSError, UnicodeDecodeError):
        raise MomentError("Could not connect to the LLM provider. Check its URL, network access, and server availability.", "provider_connection_error", 502) from None


class LLMProvider(Protocol):
    config: ProviderConfig

    def complete_json(self, messages: list[dict], schema: dict) -> dict: ...


class OpenAIProvider:
    def __init__(self, config: ProviderConfig):
        self.config = config

    def complete_json(self, messages: list[dict], schema: dict) -> dict:
        fmt = {"type": "json_object"} if self.config.response_format == "json_object" else {
            "type": "json_schema", "json_schema": {"name": "clipforge_moments", "strict": True, "schema": schema},
        }
        token_key = "max_completion_tokens" if self.config.provider == "openai" else "max_tokens"
        data = post_json(self.config, "/chat/completions", {
            "model": self.config.model, "messages": messages, "response_format": fmt,
            token_key: self.config.max_tokens, "stream": False,
        })
        try:
            choice = data["choices"][0]
            message = choice["message"]
            if message.get("refusal"):
                raise MomentError("The LLM provider declined to analyze this transcript.", "provider_refusal")
            if choice.get("finish_reason") != "stop":
                raise MomentError("The LLM response was incomplete or filtered. Try fewer candidates or a larger output token limit.", "incomplete_provider_response")
            return parse_json(message["content"])
        except (KeyError, IndexError, TypeError, AttributeError):
            raise MomentError("The LLM returned an unexpected chat-completion response.", "invalid_provider_response") from None


class OllamaProvider:
    def __init__(self, config: ProviderConfig):
        self.config = config

    def complete_json(self, messages: list[dict], schema: dict) -> dict:
        data = post_json(self.config, "/api/chat", {
            "model": self.config.model, "messages": messages, "stream": False, "format": schema,
            "options": {"temperature": 0.1, "num_predict": self.config.max_tokens, "num_ctx": self.config.context_tokens},
        })
        try:
            if data.get("error"):
                raise MomentError("Ollama could not run this model. Check the server and installed models.", "provider_error")
            if data.get("done") is not True or data.get("done_reason") == "length":
                raise MomentError("Ollama returned an incomplete analysis. Increase the output token limit or use fewer candidates.", "incomplete_provider_response")
            return parse_json(data["message"]["content"])
        except (KeyError, TypeError):
            raise MomentError("Ollama returned an unexpected chat response.", "invalid_provider_response") from None


PROVIDERS = {"openai": OpenAIProvider, "openai_compatible": OpenAIProvider, "ollama": OllamaProvider}


def create_provider(config: ProviderConfig) -> LLMProvider:
    return PROVIDERS[config.provider](config)