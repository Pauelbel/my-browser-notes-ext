import {Vault, encode, setting} from '../storage.js';
if (location.hostname !== '127.0.0.1') throw Error('Тестовая страница доступна только на localhost');
const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('quiet-notes-test', {create:true});
const vault = new Vault(root);
const trashSeed = document.createElement('button'); trashSeed.textContent = 'Добавить две тестовые заметки в корзину';
document.body.append(trashSeed);
trashSeed.onclick = async () => {
  for (const title of ['Удалённая идея','Список покупок']) {
    const id = crypto.randomUUID();
    await vault.write(`.trash/${id}.md`, encode({title,tags:['тест'],body:'Тестовая заметка для проверки выбора и восстановления.',originalPath:`Работа/${id}.md`}));
  }
  await setting('vault',{root,id:'browser-test'});
  document.getElementById('result').textContent = 'Две тестовые заметки в корзине.';
};
document.getElementById('seed').onclick = async () => {
  const path = `Работа/Пример-${crypto.randomUUID()}.md`;
  await vault.write(path, encode({title:'Идеи для новой недели',tags:['работа','идеи'],body:'## Главное\n\n- [ ] Собрать мысли\n- [ ] Оставить время для себя\n\nЗдесь всё сохраняется в Markdown.'}));
  await setting('vault',{root,id:'browser-test'});
  document.getElementById('result').textContent = 'Тестовая коллекция готова. Откройте интерфейс.';
};
document.getElementById('inspect').onclick = async () => {
  document.getElementById('result').textContent = JSON.stringify(await vault.scan(),null,2);
};
