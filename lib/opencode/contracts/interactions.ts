import type { ScopedOpencodeClient, PendingQuestionAnswer, PendingQuestionRequest } from '../client/types';
import { mapPermission, formToQuestion, mapSavedPermission, toAnswer } from '../v2/mappers';
import { clarifyAnswerToWire, clarifyToPendingQuestion } from '@/lib/hermes/mapping';
const location = (client: ScopedOpencodeClient) => ({ location: { directory: client.__opencode.directory } });

// Hermes: run approvals are not listable (they arrive on the run's event
// stream and are handled by the Hermes runs coordinator), but clarify
// questions are — the plugin answers /clarify for every pending question.
async function listHermesQuestions(client: ScopedOpencodeClient): Promise<PendingQuestionRequest[]> {
  const entries = await client.hermes!.api.getClarifications();
  return entries
    .filter((entry) => !entry.status || entry.status === 'pending')
    .map((entry) => clarifyToPendingQuestion(entry, entry.session_id ?? ''));
}

export async function listPendingPermissions(client: ScopedOpencodeClient) {
  if (client.hermes) return [];
  if (client.compatibility) return (await client.compatibility.permission.list()).data;
  return (await client.api!.permission.request.list(location(client))).data.map((item) => mapPermission(item, client.context));
}
export async function listPendingQuestions(client: ScopedOpencodeClient): Promise<PendingQuestionRequest[] | undefined> {
  if (client.hermes) return await listHermesQuestions(client);
  if (client.compatibility) return (await client.compatibility.question.list()).data;
  return (await client.api!.form.list(location(client))).data.map((item) => formToQuestion(item, client.context));
}
export async function listPendingInteractions(client: ScopedOpencodeClient) {
  const [permissions, questions] = await Promise.allSettled([listPendingPermissions(client), listPendingQuestions(client)]);
  const p = permissions.status === 'fulfilled' ? permissions.value : undefined;
  const q = questions.status === 'fulfilled' ? questions.value : undefined;
  if (!p && !q) throw permissions.status === 'rejected' ? permissions.reason : questions.status === 'rejected' ? questions.reason : new Error('OpenCode did not return pending interactions.');
  return { permissions: p, questions: q };
}
async function permissionSession(client: ScopedOpencodeClient, id: string) {
  if (!client.context!.permissionSession.has(id)) await listPendingPermissions(client);
  const sessionID = client.context!.permissionSession.get(id);
  if (!sessionID) throw new Error('This permission request is no longer available.');
  return sessionID;
}
async function form(client: ScopedOpencodeClient, id: string) {
  if (!client.context!.formSession.has(id)) await listPendingQuestions(client);
  const request = client.context!.formSession.get(id);
  if (!request) throw new Error('This question is no longer available.');
  return request;
}
export async function replyToPendingPermission(client: ScopedOpencodeClient, requestID: string, reply: 'once' | 'always' | 'reject') {
  if (client.hermes) throw new Error('Run approvals are answered through the run stream.');
  if (client.compatibility) { await client.compatibility.permission.reply({ requestID, reply }); return; }
  await client.api!.permission.reply({ sessionID: await permissionSession(client, requestID), requestID, decision: reply });
  client.context!.permissionSession.delete(requestID);
}
export async function replyToPendingQuestion(client: ScopedOpencodeClient, requestID: string, answers: PendingQuestionAnswer[]) {
  if (client.hermes) {
    const entry = (await client.hermes.api.getClarifications()).find((candidate) => candidate.id === requestID);
    if (!entry) throw new Error('This question is no longer available.');
    await client.hermes.api.answerClarification(requestID, clarifyAnswerToWire(entry, answers as (string[] | undefined)[]));
    return;
  }
  if (client.compatibility) { await client.compatibility.question.reply({ requestID, answers }); return; }
  const request = await form(client, requestID);
  await client.api!.session.form.reply({ sessionID: request.sessionID, formID: request.id, answer: toAnswer(request, answers) });
  client.context!.formSession.delete(requestID);
}
export async function rejectPendingQuestion(client: ScopedOpencodeClient, requestID: string) {
  if (client.hermes) {
    // Hermes has no reject: skipping answers every question with null.
    const entry = (await client.hermes.api.getClarifications()).find((candidate) => candidate.id === requestID);
    if (!entry) return;
    await client.hermes.api.answerClarification(requestID, clarifyAnswerToWire(entry, (entry.questions ?? []).map(() => undefined)));
    return;
  }
  if (client.compatibility) { await client.compatibility.question.reject({ requestID }); return; }
  const request = await form(client, requestID);
  await client.api!.session.form.cancel({ sessionID: request.sessionID, formID: request.id });
  client.context!.formSession.delete(requestID);
}
export async function listSavedPermissionRules(client: ScopedOpencodeClient) {
  if (client.hermes) return [];
  return client.api ? (await client.api.permission.saved.list()).map(mapSavedPermission) : [];
}
export async function removeSavedPermissionRule(client: ScopedOpencodeClient, id: string) {
  if (!client.api) throw new Error('Saved permission rules require OpenCode 2.');
  await client.api.permission.saved.remove({ id });
}
