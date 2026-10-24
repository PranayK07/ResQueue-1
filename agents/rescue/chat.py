"""Agent Chat Protocol helpers shared by the ASI:One-facing agents."""
from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from uagents import Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    MetadataContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.contrib.protocols.chat.cards import extract_card_response

# (ctx, sender, text, card_selection) -> list of content blocks to reply with
Handler = Callable[[Context, str, str, dict[str, Any] | None], Awaitable[list]]


def text(t: str) -> TextContent:
    return TextContent(type="text", text=t)


def build_chat_protocol(handler: Handler) -> Protocol:
    """ACP v0.3 protocol that acks every message and routes text + card
    responses to `handler`. Card selections can arrive as MetadataContent,
    as raw JSON text (direct @mention), or as prose via the ASI:One planner,
    so we try all three."""
    proto = Protocol(spec=chat_protocol_spec)

    @proto.on_message(ChatMessage)
    async def _on_chat(ctx: Context, sender: str, msg: ChatMessage):
        await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))
        selection: dict[str, Any] | None = None
        parts: list[str] = []
        for item in msg.content:
            if isinstance(item, MetadataContent):
                resp = extract_card_response(item)
                if resp and not resp.cancelled and resp.selection:
                    selection = dict(resp.selection)
            elif isinstance(item, TextContent):
                parts.append(item.text)
            elif isinstance(item, (StartSessionContent, EndSessionContent)):
                continue
        body = "\n".join(parts).strip()
        if selection is None and body.startswith("{"):
            try:
                maybe = json.loads(body)
                if isinstance(maybe, dict):
                    selection = maybe
            except json.JSONDecodeError:
                pass
        if not body and selection is None:
            return
        try:
            reply = await handler(ctx, sender, body, selection)
        except Exception as e:  # noqa: BLE001 - never leave a user hanging
            ctx.logger.exception("chat handler failed")
            reply = [text(f"Sorry, something went wrong on our side ({type(e).__name__}). Please try again.")]
        if reply:
            await ctx.send(sender, ChatMessage(content=reply))

    @proto.on_message(ChatAcknowledgement)
    async def _on_ack(_ctx: Context, _sender: str, _msg: ChatAcknowledgement):
        pass

    return proto


async def push(ctx: Context, to: str, *blocks) -> None:
    """Agent-initiated message into an ongoing ASI:One conversation."""
    await ctx.send(to, ChatMessage(content=list(blocks)))
