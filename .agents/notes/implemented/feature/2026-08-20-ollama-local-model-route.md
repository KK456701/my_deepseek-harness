# Agent Note: Local Ollama model route

Status: implemented

English | [中文](2026-08-20-ollama-local-model-route.zh.md)

## Problem

The deployed Web client exposed every configured provider in one undifferentiated list. A local Ollama route then looked like another metered API provider, even though it runs through a loopback server and should be selected alongside cloud models in the composer.

## Decision

The deployment config declares `ollama-local` as an `llm-pi-ai` route using Ollama's OpenAI-compatible `/v1` endpoint. Its catalog contains only locally installed chat models; embedding-only models are not conversation choices. The route names a placeholder credential reference because the shared OpenAI adapter requires an API key field even when Ollama does not authenticate requests.

Models settings renders that stable route id under **Local Ollama models** and every other configured route under **Cloud API models**. It does not infer locality from `baseURL`: a cloud gateway can legitimately be exposed through a loopback address. The existing dynamic session model directory already groups models by provider, so the configured route appears in the composer without a second picker implementation.

## Alternatives considered

**Classify every loopback endpoint as local.** This would give an attractive but false label to local proxy gateways for cloud services.

**Add a separate Ollama provider adapter.** Ollama's OpenAI-compatible endpoint already satisfies the installed pi-ai adapter. A second adapter would duplicate request handling without adding a user-visible capability.

## Consequences

Local models are selectable per conversation while the deployed cloud default remains unchanged. If the Ollama server is stopped, selection still exists but a request reports the endpoint failure. The local route does not incur DeepSeek API usage; local inference speed and capacity depend on the computer and selected model.

## Testing

The Models settings component test pins route-id grouping. Deployment verification checks Ollama's installed model catalog and its OpenAI-compatible endpoint before the route is exposed.

## Related

[Session model selection in the Web composer](2026-07-24-web-session-model-selector.md) owns dynamic provider/model grouping and session-scoped selection.
