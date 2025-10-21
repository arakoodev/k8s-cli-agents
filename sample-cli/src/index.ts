import boxen from 'boxen';
import chalk from 'chalk';
import ora from 'ora';
import { Listr } from 'listr2';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runClaude } from './lib/claude.js';

async function runAll(){
  const header = boxen(chalk.cyanBright('Root Workflow') + ' ' + chalk.gray('- Stage-wise demo'), { padding:1, borderColor:'cyan', borderStyle:'round' });
  console.log(header);

  const spinner = ora({ text:'Prepare Workspace', spinner:'dots' }).start();
  await new Promise(r=>setTimeout(r,300)); spinner.succeed('Prepare Workspace');
  const g = ora('Generate Glossaries').start(); await new Promise(r=>setTimeout(r,300)); g.succeed('Generate Glossaries');
  const c = ora('Consolidate API Docs').start(); await new Promise(r=>setTimeout(r,300)); c.succeed('Consolidate API Docs');

  const tasks = new Listr([
    { title: chalk.yellow('Fetch Task (demo)'), task: async ()=>{ await new Promise(r=>setTimeout(r,300)); } },
    { title: chalk.magenta('Run Workflows'), task: () => new Listr([
        { title: chalk.green('AI-IMPLEMENT'), task: async (_ctx, task)=>{
            task.output = chalk.gray('Preparing branch...'); await new Promise(r=>setTimeout(r,300));
            task.output = chalk.gray('Implementing code...'); await new Promise(r=>setTimeout(r,300));
            task.output = chalk.gray('Running tests...'); await new Promise(r=>setTimeout(r,300));
          }, options:{ persistentOutput:true }
        },
        { title: chalk.green('AI-CREATE-PRD'), task: async (_ctx, task)=>{
            task.output = chalk.gray('Assembling PRD...'); await new Promise(r=>setTimeout(r,300));
            task.output = chalk.gray('Uploading PRD...'); await new Promise(r=>setTimeout(r,300));
          }, options:{ persistentOutput:true }
        },
        { title: chalk.green('AI-SECURITY-AUDIT (Claude Code/SDK)'), task: async (_ctx, task)=>{
            const prompt = process.env.CLAUDE_PROMPT || 'Analyze the authentication system and suggest improvements';
            const res = await runClaude(prompt);
            task.output = chalk.gray(res.slice(0,800) + '\n...');
          }, options:{ persistentOutput:true }
        }
      ], { concurrent:false })
    }
  ], { rendererOptions:{ collapseErrors:false } });
  await tasks.run();
  console.log(chalk.gray('\nRestore Task State'));
}

const argv = yargs(hideBin(process.argv)).command('run','run demo',()=>{}, async ()=>{ await runAll(); }).demandCommand(1).help().argv;
