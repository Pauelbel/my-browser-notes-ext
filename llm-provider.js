export class OpenAICompatibleProvider {
  constructor(config) {
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || '';
    this.timeout = Math.max(5_000, Number(config.timeout) || 180_000);
  }
  headers() {
    return {'Content-Type':'application/json', ...(this.apiKey ? {Authorization:`Bearer ${this.apiKey}`} : {})};
  }
  async request(path, options = {}) {
    if (!this.baseUrl) throw Error('Укажите Base URL LLM.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {...options, headers:{...this.headers(), ...options.headers}, signal:controller.signal});
      if (!response.ok) throw Error(`LLM вернула HTTP ${response.status}: ${(await response.text()).slice(0,300)}`);
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw Error(`Полный ответ LLM не получен за ${Math.round(this.timeout / 1000)} с. Увеличьте Timeout.`);
      throw error;
    } finally { clearTimeout(timer); }
  }
  async getModels() {
    const result = await this.request('/models');
    return (result.data || []).map(item => item.id).filter(Boolean);
  }
  async testConnection() { return this.getModels(); }
  async ask(messages) {
    if (!this.model) throw Error('Укажите модель LLM.');
    const result = await this.request('/chat/completions', {method:'POST', body:JSON.stringify({
      model:this.model, messages, temperature:0.2, max_tokens:1200, stream:false
    })});
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw Error('LLM не вернула ответ.');
    return content.trim();
  }
  async chat(messages) {
    if (!this.model) throw Error('Укажите модель LLM.');
    const planSchema = {
      name:'knowledge_base_operations', strict:true,
      schema:{type:'object',additionalProperties:false,properties:{
        summary:{type:'string'},
        operations:{type:'array',maxItems:100,items:{anyOf:[
          {type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['write']},path:{type:'string'},content:{type:'string'}},required:['type','path','content']},
          {type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['move']},from:{type:'string'},to:{type:'string'}},required:['type','from','to']},
          {type:'object',additionalProperties:false,properties:{type:{type:'string',enum:['delete']},path:{type:'string'}},required:['type','path']}
        ]}}
      },required:['summary','operations']}
    };
    const result = await this.request('/chat/completions', {method:'POST', body:JSON.stringify({
      model:this.model, messages, temperature:0.1, max_tokens:16384, stream:false,
      response_format:{type:'json_schema',json_schema:planSchema}
    })});
    const choice = result.choices?.[0];
    const reason = choice?.finish_reason;
    const tokens = result.usage?.completion_tokens;
    this.lastDiagnostics = `Завершение: ${reason || 'не указано'}; токенов ответа: ${tokens ?? 'не указано'}.`;
    if (reason === 'length') throw Error(`Ответ LLM оборван лимитом токенов; неполный план не применён. ${this.lastDiagnostics}`);
    if (choice?.message?.refusal || reason === 'content_filter') throw Error('LLM отказалась сформировать план. Файлы не изменены.');
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw Error(`LLM не вернула текстовый план. ${this.lastDiagnostics}`);
    return content;
  }
}
