# Agent Note: DeepSeek balance in Web statistics

Status: implemented

English | [中文](2026-08-18-deepseek-balance-web-stats.zh.md)

## Problem

The Web conversation statistics strip reports Session activity but cannot report the account funds that pay for DeepSeek requests. The browser cannot safely call the provider itself because the API key belongs to the Host credential service, while writing account balance into the Session log would incorrectly turn external account state into durable conversation state.

## Decision

`LlmRuntime` owns a settings-namespace-keyed account-balance registry. A provider plugin registers one query for its namespace and returns provider-neutral currency lines containing a total and optional granted and topped-up portions. Registration is a Cordis effect and disappears with its owning fiber.

`dsh-llm-deepseek` registers the `llm-deepseek` query. Each call resolves the same current endpoint and credential snapshot used by model requests, sends `GET {baseURL}/user/balance`, and validates the untrusted JSON before returning it. Provider errors name the endpoint or status but never include the credential.

The Host exposes the query as privileged `llm.balance` RPC. The Web statistics strip requests the DeepSeek namespace on mount, after token usage advances, and when the browser window regains focus. A newer refresh aborts its predecessor, unmount aborts the active request, all returned currency lines render in provider order, and an unavailable query leaves the balance group absent without changing Session statistics.

## Alternatives considered

**Call DeepSeek directly from the browser.** Rejected because it would move the API key into browser state, bypass the Host credential authority, and depend on provider CORS behavior.

**Poll on a fixed interval.** Rejected because an arbitrary interval is deployment policy hidden in a presentation component and continues network traffic when no balance-changing activity occurs. Model usage and window focus provide meaningful refresh points without a timer.

**Record balance in the Session log.** Rejected because account funds are external mutable state, not a durable fact about one conversation, and must not enter model history, replay, fork, or compaction.

## Consequences

The Web strip shows each DeepSeek currency balance after initial load and refreshes immediately after locally billed model work. Changes made by another client while this window remains continuously backgrounded appear when the window next receives focus rather than through background polling.

The browser receives amounts but never the credential. Balance reads make no model call, append no Session event, and add no prompt or KV-cache content. A configured gateway must expose the DeepSeek balance endpoint under its configured base URL; otherwise the conversation remains usable and the balance group stays hidden.

Provider-composition tests pin the HTTP method, path, credential header, response validation, and credential-safe failure. Registry, Host RPC, carrier, client fixture, and component tests pin lifecycle disposal, privileged transport, multi-currency rendering, refresh triggers, and cancellation.
