#!/usr/bin/env python3
"""本地 LLM 服务:OpenAI 兼容接口,供 msg2todo 调用。
模型:Qwen2.5-3B-Instruct (BF16, GPU)
监听: http://127.0.0.1:11434/v1/chat/completions
"""
import json
import os
import sys

MODEL_DIR = os.path.expanduser('~/.local/llm-models/Qwen2.5-3B-Instruct')
MODEL_NAME = 'qwen2.5-3b-instruct'
PORT = int(os.environ.get('LLM_PORT', '11434'))

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

app = FastAPI()
model = None
tokenizer = None

SYSTEM_TEMPLATE = '''你是一个待办事项提取助手。用户会给你一条聊天消息,你需要判断它是否包含需要记录的待办事项,并提取结构化信息。

判断规则:
1. isTodo 为 true 当且仅当消息明确表达了「用户需要记住、或需要在某个时间点去做的事情」,例如:开会、交作业、还书、买东西、回电话、提交材料、赴约、取快递等。
2. 纯闲聊、问候、疑问、陈述事实(没有行动意图)一律 isTodo=false。
3. title 要简洁、尽量动词开头,保留关键信息(人名、事件、地点),去掉"提醒我/记得/帮我"这类前缀。
4. dueAt:消息里有时间就输出 ISO 8601 格式(带时区偏移,如 2026-10-07T15:00:00+08:00),没有则为 null。用户说"明天/下周五"等相对时间时,以给出的当前时间为基准推算。
5. priority:根据紧迫程度判断,只能是 high / medium / low,默认 medium。
6. notes:需要补充的说明(地点、对象、上下文),没有则为空字符串。

只输出一个 JSON 对象,不要输出任何其他文字。'''

USER_TEMPLATE = '''当前时间:{now}
聊天消息:「{text}」

请输出 JSON:{{"isTodo":布尔值,"title":字符串,"dueAt":ISO8601字符串或null,"priority":"high|medium|low","notes":字符串}}'''


@app.on_event('startup')
def load_model():
    global model, tokenizer
    print(f'[llm] 加载模型 {MODEL_DIR} ...', flush=True)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_DIR,
        torch_dtype=torch.bfloat16,
        device_map='cuda',
        trust_remote_code=True,
    )
    model.eval()
    print('[llm] 模型加载完成, GPU 显存占用:', round(torch.cuda.memory_allocated() / 1e9, 2), 'GB', flush=True)


@app.get('/v1/models')
def list_models():
    return {'object': 'list', 'data': [{'id': MODEL_NAME, 'object': 'model'}]}


@app.post('/v1/chat/completions')
async def chat(request: Request):
    body = await request.json()
    messages = body.get('messages', [])
    system = next((m['content'] for m in messages if m['role'] == 'system'), SYSTEM_TEMPLATE)
    user = next((m['content'] for m in messages if m['role'] == 'user'), '')

    text = tokenizer.apply_chat_template(
        [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
        tokenize=False,
        add_generation_prompt=True,
    )
    inputs = tokenizer(text, return_tensors='pt').to('cuda')
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=512,
            do_sample=False,
            temperature=0.1,
            pad_token_id=tokenizer.eos_token_id,
        )
    reply = tokenizer.decode(outputs[0][inputs['input_ids'].shape[1]:], skip_special_tokens=True).strip()
    print('[llm] 输出:', reply[:160].replace('\n', ' '), flush=True)
    return JSONResponse({
        'id': 'local',
        'object': 'chat.completion',
        'model': MODEL_NAME,
        'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': reply}, 'finish_reason': 'stop'}],
        'usage': {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0},
    })


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=PORT, log_level='info')
