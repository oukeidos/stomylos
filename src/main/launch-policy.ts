import { isAbsolute, resolve } from 'node:path';

// Only the explicit, built-source personal entry may open normal data without
// packaging. A development server or mock endpoint must never use that entry.
export function launchData(packaged: boolean, argv: string[], env: NodeJS.ProcessEnv, normalDirectory: string) {
  const personal = argv.includes('--stomylos-personal');
  const override = env.STOMYLOS_DATA_DIR;
  if (personal && (override !== undefined || env.ELECTRON_RENDERER_URL || env.STOMYLOS_TEST_ENDPOINT)) {
    throw new Error('Personal execution cannot use development data, a development server or a test endpoint.');
  }
  const directory = override ?? (packaged || personal ? normalDirectory : undefined);
  const normalData = directory !== undefined && resolve(directory) === normalDirectory;
  if (!directory || !isAbsolute(directory) || (!packaged && !personal && normalData)) {
    throw new Error('An isolated absolute STOMYLOS_DATA_DIR is required for this development build.');
  }
  if (normalData && (env.ELECTRON_RENDERER_URL || env.STOMYLOS_TEST_ENDPOINT)) {
    throw new Error('Normal history cannot be used with a development server or a test endpoint.');
  }
  return { directory, normalData };
}
