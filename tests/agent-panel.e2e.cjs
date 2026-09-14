const {chromium} = require('C:/Users/pvbbe/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
(async()=>{
  const browser = await chromium.launch({headless:true,channel:'chrome'});
  try {
    const page = await browser.newPage({viewport:{width:420,height:900}});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    let state={id:'test',messages:[],events:[],busy:false,error:null,elapsed:0,tokens:null,partial:false,requests:0};
    let sent;
    await page.route('http://127.0.0.1:8765/**',async route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      const headers={'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type'};
      if(req.method()==='OPTIONS')return route.fulfill({status:200,headers,body:'{}'});
      if(req.headers().authorization!=='Bearer test-key')return route.fulfill({status:401,headers,json:{error:'Проверьте ключ подключения к агенту.'}});
      if(path==='/health')return route.fulfill({headers,json:{status:'ok'}});
      if(path==='/sessions')return route.fulfill({headers,json:{id:'test'}});
      if(path.endsWith('/messages')){
        sent=req.postDataJSON(); state={...state,busy:false,elapsed:3.2,tokens:142,requests:1,events:[{инструмент:'чтение_файла',статус:'готово'}],messages:[{role:'user',content:sent.message,note:sent.note?.title},{role:'assistant',content:'## Результат\n**Готово**\n```python\nprint("Привет")\n```\n<script>alert(1)</script>'}]};
        return route.fulfill({status:202,headers,json:{accepted:true}});
      }
      return route.fulfill({headers,json:state});
    });
    await page.goto('http://127.0.0.1:4173');
    await page.locator('#new').click();
    await page.locator('#title').fill('Проверочная заметка');
    await page.locator('#body .tiptap').fill('Текст только выбранной заметки');
    await page.locator('#agentToggle').click();
    await page.locator('#agentKey').fill('wrong-key'); await page.locator('#agentConnect').click();
    await page.getByText('Проверьте ключ подключения к агенту.',{exact:true}).waitFor();
    await page.locator('#agentKey').fill('test-key'); await page.locator('#agentConnect').click();
    await page.waitForFunction(()=>!document.querySelector('#agentSend').disabled);
    await page.locator('#agentAttach').click();
    await page.locator('#agentAttached').filter({hasText:'Проверочная заметка'}).waitFor();
    await page.locator('#agentInput').fill('Объясни заметку');
    await page.locator('#agentSend').click();
    await page.getByRole('button',{name:'Сохранить как заметку',exact:true}).waitFor();
    assert.equal(sent.note.body.trim(),'Текст только выбранной заметки');
    assert.equal(await page.locator('#agentMessages script').count(),0);
    assert.match(await page.locator('#agentStats').textContent(),/142/);
    await page.screenshot({path:'tests/agent-panel.png',fullPage:true});
    await page.getByRole('button',{name:'Сохранить как заметку',exact:true}).click();
    await page.getByRole('button',{name:'Сохранено в заметках',exact:true}).waitFor();
    await page.locator('#agentToggle').click();
    await page.locator('#list').getByText(/Ответ агента/).first().waitFor();
    assert.deepEqual(errors,[]);
    console.log('Интерфейс: подключение, неверный ключ, заметка, ответ, статистика, безопасный вывод и сохранение — проверены.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
