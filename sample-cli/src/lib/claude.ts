import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';

export async function runClaude(prompt:string): Promise<string> {
  // Try Claude CLI first
  const cli = await runClaudeCli(prompt);
  if (cli) return cli;
  // fallback SDK
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return '[mock] No claude CLI or ANTHROPIC_API_KEY present; returning mock output for demo.';
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({ model: 'claude-3-5-sonnet-latest', max_tokens: 300, temperature: 0.2, messages:[{ role:'user', content: prompt }] });
  const text = msg.content?.map((c:any)=>c.text||'').join('\n') || JSON.stringify(msg);
  return text;
}

function runClaudeCli(prompt:string): Promise<string|undefined>{
  return new Promise((resolve)=>{
    const bin = process.env.CLAUDE_BIN || 'claude';
    const child = spawn(bin, ['--permission-mode','plan','-p', prompt], { stdio:['ignore','pipe','pipe'] });
    let out = '', err='';
    child.stdout.on('data', d=> out += d.toString());
    child.stderr.on('data', d=> err += d.toString());
    child.on('error', ()=> resolve(undefined));
    child.on('close', (code)=> code===0 ? resolve(out) : resolve(undefined));
  });
}
