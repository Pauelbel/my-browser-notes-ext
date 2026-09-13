import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snapshotInbox, requireNonemptyPlan, emptyPlanFeedback, sourceRecords} from '../inbox-pipeline.js';

test('verification snapshot stays readable after original file is changed or removed', async () => {
  let invalid = false;
  const files = [{path:'00_Inbox/inbox.md',file:{async arrayBuffer() {
    if (invalid) throw new DOMException('File changed','NotReadableError');
    return new TextEncoder().encode('Исходный текст').buffer;
  }}}];
  const snapshot = await snapshotInbox(files);
  invalid = true;
  await assert.rejects(files[0].file.arrayBuffer());
  assert.equal(await snapshot[0].file.text(),'Исходный текст');
});
test('empty model plan cannot reach file writes or Inbox cleanup', () => {
  assert.throws(() => requireNonemptyPlan([]), /Исходники не изменены/);
  assert.doesNotThrow(() => requireNonemptyPlan([{type:'write'}]));
});
test('empty plan correction identifies actual inputs and states that no operations ran', () => {
  const feedback = emptyPlanFeedback([{path:'00_Inbox/inbox.md',size:123}]);
  assert.ok(feedback.includes('00_Inbox/inbox.md: 123 байт'));
  assert.ok(feedback.includes('Никакие операции предыдущего ответа не выполнялись'));
});
test('source path is flat, stable and contains a content hash', async () => {
  const records = await sourceRecords([{path:'00_Inbox/вложенная/тест.txt', file:new Blob(['данные'])}]);
  assert.match(records[0].path, /^90_Источники\/00_Inbox__вложенная__тест-[a-f0-9]{12}\.txt$/);
});
