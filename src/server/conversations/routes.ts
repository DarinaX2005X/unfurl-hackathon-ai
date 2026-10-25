import "server-only";
import { dispatchOwnedExecution } from "../runs/dispatcher";
import { NextResponse, type NextRequest } from "next/server";
import { IdSchema } from "../../domain/common";
import {
  CONVERSATION_BODY_LIMIT, MESSAGE_BODY_LIMIT, CloudSendMessageInputSchema, ConversationActionQuerySchema, ConversationQuerySchema, CreateConversationInputSchema,
  DeleteConversationInputSchema, ImportConversationInputSchema, RenameConversationInputSchema, SaveComposerInputSchema,
} from "../../domain/conversations";
import { requireActor } from "../auth/session";
import { assertSameOrigin, failure, readInput, success } from "../auth/http";
import { privateResponse } from "../auth/client";
import { ServiceFault } from "../auth/errors";
import { conversationService } from "./service";

function keyFor(request: Request): string {
  const key = IdSchema.safeParse(request.headers.get("Idempotency-Key"));
  if (!key.success) throw new ServiceFault(400, "invalid_input", "request.invalidIdempotencyKey");
  return key.data;
}
function idFor(id: string): string {
  const parsed = IdSchema.safeParse(id);
  if (!parsed.success) throw new ServiceFault(400, "invalid_input", "chat.invalidInput");
  return parsed.data;
}

export async function listConversationsRoute(request: NextRequest) {
  try {
    const actor = await requireActor();
    const params = request.nextUrl.searchParams;
    for (const key of params.keys()) if (!["cursor", "limit"].includes(key) || params.getAll(key).length !== 1) throw new ServiceFault(400, "invalid_input", "chat.invalidInput");
    const parsed = ConversationQuerySchema.safeParse({
      ...(params.has("cursor") ? { cursor: params.get("cursor") } : {}),
      ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}),
    });
    if (!parsed.success) throw new ServiceFault(400, "invalid_input", "chat.invalidInput");
    return success(await conversationService.list(actor, parsed.data));
  } catch (error) { return failure(error, request); }
}
export async function createConversationRoute(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const key = keyFor(request);
    const body = await readInput(request, CreateConversationInputSchema, { maxBytes: MESSAGE_BODY_LIMIT });
    const receipt = await conversationService.create(actor, body, key);
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
export async function getConversationRoute(request: NextRequest, id: string) {
  try { const actor=await requireActor();const data=await conversationService.get(actor,idFor(id));await dispatchOwnedExecution(actor);return success(data); }
  catch (error) { return failure(error, request); }
}
export async function getConversationActionsRoute(request: NextRequest, id: string) {
  try {
    const actor = await requireActor();
    const params = request.nextUrl.searchParams;
    for (const key of params.keys()) if (!["cursor", "limit"].includes(key) || params.getAll(key).length !== 1) throw new ServiceFault(400, "invalid_input", "chat.invalidInput");
    const parsed = ConversationActionQuerySchema.safeParse({ ...(params.has("cursor") ? { cursor: params.get("cursor") } : {}),
      ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}) });
    if (!parsed.success) throw new ServiceFault(400, "invalid_input", "chat.invalidInput");
    return success(await conversationService.actions(actor, idFor(id), parsed.data));
  } catch (error) { return failure(error, request); }
}
export async function renameConversationRoute(request: NextRequest, id: string) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const key = keyFor(request);
    const body = await readInput(request, RenameConversationInputSchema);
    const receipt = await conversationService.rename(actor, idFor(id), body, key);
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
export async function deleteConversationRoute(request: NextRequest, id: string) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const key = keyFor(request);
    const body = await readInput(request, DeleteConversationInputSchema);
    await conversationService.remove(actor, idFor(id), body, key);
    await dispatchOwnedExecution(actor);
    return privateResponse(new NextResponse(null, { status: 204 }));
  } catch (error) { return failure(error, request); }
}
export async function saveComposerRoute(request: NextRequest, id: string) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const key = keyFor(request);
    const body = await readInput(request, SaveComposerInputSchema, { maxBytes: CONVERSATION_BODY_LIMIT });
    const receipt = await conversationService.saveComposer(actor, idFor(id), body, key);
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
export async function importConversationRoute(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const key = keyFor(request);
    const body = await readInput(request, ImportConversationInputSchema, { maxBytes: CONVERSATION_BODY_LIMIT });
    const receipt = await conversationService.importLocal(actor, body, key);
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
export async function sendMessageRoute(request: NextRequest, id: string) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor();
    const key = keyFor(request);
    const body = await readInput(request, CloudSendMessageInputSchema, { maxBytes: MESSAGE_BODY_LIMIT });
    if (body.conversationId !== idFor(id)) throw new ServiceFault(400, "invalid_input", "chat.invalidInput");
    const receipt = await conversationService.sendMessage(actor, body, key);
    await dispatchOwnedExecution(actor,receipt.data.run.id);
    return success(receipt.data, receipt.status);
  } catch (error) { return failure(error, request); }
}
