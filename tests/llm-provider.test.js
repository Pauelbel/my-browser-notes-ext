import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OpenAICompatibleProvider} from '../llm-provider.js';

test('structured plan supports complete file contents and operation-specific required fields', async () => {
  const provider = new OpenAICompatibleProvider({baseUrl:'http://localhost:1234/v1',model:'test'});
  const content = JSON.stringify({summary:'Готово',operations:[{type:'write',path:'note.md',content:'Текст '.repeat(2000)}]});
  provider.request = async (_path, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.max_tokens > 800);
    const variants = body.response_format.json_schema.schema.properties.operations.items.anyOf;
    assert.deepEqual(variants[0].required, ['type','path','content']);
    return {choices:[{finish_reason:'stop',message:{content}}],usage:{completion_tokens:2000}};
  };
  assert.equal(await provider.chat([]),content);
});
test('truncated JSON is rejected before being passed to the executor', async () => {
  const provider = new OpenAICompatibleProvider({model:'test'});
  provider.request = async () => ({choices:[{finish_reason:'length',message:{content:'{"operations":['}}],usage:{completion_tokens:800}});
  await assert.rejects(provider.chat([]), /оборван лимитом токенов.*800/);
});
test('reasoning-only response is reported without exposing reasoning', async () => {
  const provider = new OpenAICompatibleProvider({model:'test'});
  provider.request = async () => ({choices:[{finish_reason:'stop',message:{content:'',reasoning_content:'hidden'}}]});
  await assert.rejects(provider.chat([]), error => error.message.includes('не вернула текстовый план') && !error.message.includes('hidden'));
});
test('note chat sends a normal completion request without a file-operation schema', async () => {
  const provider = new OpenAICompatibleProvider({model:'test'});
  provider.request = async (_path, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens,1200);
    assert.equal(body.response_format,undefined);
    return {choices:[{message:{content:'Ответ по заметке'}}]};
  };
  assert.equal(await provider.ask([{role:'user',content:'Вопрос'}]),'Ответ по заметке');
});
