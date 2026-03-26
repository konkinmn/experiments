import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', 'prompts');

export interface Prompt {
  id: string;
  name: string;
}

export interface PromptWithContent extends Prompt {
  content: string;
}

function formatPromptName(filename: string): string {
  return filename
    .replace('.md', '')
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export async function getPromptsList(): Promise<Prompt[]> {
  const files = await readdir(PROMPTS_DIR);
  const mdFiles = files.filter((f) => f.endsWith('.md'));

  return mdFiles.map((filename) => ({
    id: filename.replace('.md', ''),
    name: formatPromptName(filename),
  }));
}

export async function listPrompts(): Promise<string[]> {
  const files = await readdir(PROMPTS_DIR);
  return files.filter((f) => f.endsWith('.md')).map((f) => f.replace('.md', ''));
}

export async function getPromptById(id: string): Promise<PromptWithContent | null> {
  const filename = `${id}.md`;
  const filepath = resolve(PROMPTS_DIR, filename);

  // Prevent path traversal — resolved path must stay inside prompts dir (trailing separator prevents sibling-prefix bypass)
  if (!filepath.startsWith(PROMPTS_DIR + '/')) {
    return null;
  }

  try {
    const content = await readFile(filepath, 'utf-8');
    return {
      id,
      name: formatPromptName(filename),
      content,
    };
  } catch {
    return null;
  }
}
