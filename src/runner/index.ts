import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { ConformanceCheck } from '../types.js';
import { getScenario } from '../scenarios/index.js';

export interface ClientExecutionResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

async function ensureResultsDir(): Promise<string> {
    const resultsDir = path.join(process.cwd(), 'results');
    await fs.mkdir(resultsDir, { recursive: true });
    return resultsDir;
}

function createResultDir(scenario: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join('results', `${scenario}-${timestamp}`);
}

async function executeClient(command: string, serverUrl: string, timeout: number = 30000): Promise<ClientExecutionResult> {
    const commandParts = command.split(' ');
    const executable = commandParts[0];
    const args = [...commandParts.slice(1), serverUrl];

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    return new Promise(resolve => {
        const process = spawn(executable, args, {
            shell: true,
            stdio: 'pipe'
        });

        const timeoutHandle = setTimeout(() => {
            timedOut = true;
            process.kill();
        }, timeout);

        if (process.stdout) {
            process.stdout.on('data', data => {
                stdout += data.toString();
            });
        }

        if (process.stderr) {
            process.stderr.on('data', data => {
                stderr += data.toString();
            });
        }

        process.on('close', code => {
            clearTimeout(timeoutHandle);
            resolve({
                exitCode: code || 0,
                stdout,
                stderr,
                timedOut
            });
        });

        process.on('error', error => {
            clearTimeout(timeoutHandle);
            resolve({
                exitCode: -1,
                stdout,
                stderr: stderr + `\nProcess error: ${error.message}`,
                timedOut
            });
        });
    });
}

export async function runConformanceTest(
    clientCommand: string,
    scenarioName: string,
    timeout: number = 30000
): Promise<{
    checks: ConformanceCheck[];
    clientOutput: ClientExecutionResult;
    resultDir: string;
}> {
    await ensureResultsDir();
    const resultDir = createResultDir(scenarioName);
    await fs.mkdir(resultDir, { recursive: true });

    const scenario = getScenario(scenarioName);
    if (!scenario) {
        throw new Error(`Unknown scenario: ${scenarioName}`);
    }

    console.log(`Starting scenario: ${scenarioName}`);
    const urls = await scenario.start();

    console.log(`Executing client: ${clientCommand} ${urls.serverUrl}`);

    try {
        const clientOutput = await executeClient(clientCommand, urls.serverUrl, timeout);

        const checks = scenario.getChecks();

        await fs.writeFile(path.join(resultDir, 'checks.json'), JSON.stringify(checks, null, 2));

        await fs.writeFile(path.join(resultDir, 'stdout.txt'), clientOutput.stdout);

        await fs.writeFile(path.join(resultDir, 'stderr.txt'), clientOutput.stderr);

        console.log(`Results saved to ${resultDir}`);

        return {
            checks,
            clientOutput,
            resultDir
        };
    } finally {
        await scenario.stop();
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let command: string | null = null;
    let scenario: string | null = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--command' && i + 1 < args.length) {
            command = args[i + 1];
            i++;
        } else if (args[i] === '--scenario' && i + 1 < args.length) {
            scenario = args[i + 1];
            i++;
        }
    }

    if (!command || !scenario) {
        console.error('Usage: runner --command "<command>" --scenario <scenario>');
        console.error('Example: runner --command "tsx examples/clients/typescript/test1.ts" --scenario initialize');
        process.exit(1);
    }

    try {
        const result = await runConformanceTest(command, scenario);

        const passed = result.checks.filter(c => c.status === 'SUCCESS').length;
        const failed = result.checks.filter(c => c.status === 'FAILURE').length;

        console.log(`\nTest Results:`);
        console.log(`Passed: ${passed}/${result.checks.length}`);
        console.log(`Failed: ${failed}/${result.checks.length}`);

        if (failed > 0) {
            console.log('\nFailed Checks:');
            result.checks
                .filter(c => c.status === 'FAILURE')
                .forEach(c => {
                    console.log(`  - ${c.name}: ${c.description}`);
                    if (c.errorMessage) {
                        console.log(`    Error: ${c.errorMessage}`);
                    }
                });
        }

        process.exit(failed > 0 ? 1 : 0);
    } catch (error) {
        console.error('Test runner error:', error);
        process.exit(1);
    }
}

main();
