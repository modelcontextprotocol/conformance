import { promises as fs } from 'fs';
import path from 'path';
import { ConformanceCheck } from './types.js';
import { getClientScenario } from './scenarios/index.js';

async function ensureResultsDir(): Promise<string> {
    const resultsDir = path.join(process.cwd(), 'results');
    await fs.mkdir(resultsDir, { recursive: true });
    return resultsDir;
}

function createResultDir(scenario: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join('results', `server-${scenario}-${timestamp}`);
}

export async function runServerConformanceTest(
    serverUrl: string,
    scenarioName: string
): Promise<{
    checks: ConformanceCheck[];
    resultDir: string;
}> {
    await ensureResultsDir();
    const resultDir = createResultDir(scenarioName);
    await fs.mkdir(resultDir, { recursive: true });

    const scenario = getClientScenario(scenarioName);
    if (!scenario) {
        throw new Error(`Unknown client scenario: ${scenarioName}`);
    }

    console.log(`Running client scenario '${scenarioName}' against server: ${serverUrl}`);

    const checks = await scenario.run(serverUrl);

    await fs.writeFile(path.join(resultDir, 'checks.json'), JSON.stringify(checks, null, 2));

    console.log(`Results saved to ${resultDir}`);

    return {
        checks,
        resultDir
    };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let serverUrl: string | null = null;
    let scenario: string | null = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--server-url' && i + 1 < args.length) {
            serverUrl = args[i + 1];
            i++;
        } else if (args[i] === '--scenario' && i + 1 < args.length) {
            scenario = args[i + 1];
            i++;
        }
    }

    if (!serverUrl || !scenario) {
        console.error('Usage: server-runner --server-url <url> --scenario <scenario>');
        console.error('Example: server-runner --server-url http://localhost:3000 --scenario initialize');
        process.exit(1);
    }

    try {
        const result = await runServerConformanceTest(serverUrl, scenario);

        const denominator = result.checks.filter(c => c.status === 'SUCCESS' || c.status == 'FAILURE').length;
        const passed = result.checks.filter(c => c.status === 'SUCCESS').length;
        const failed = result.checks.filter(c => c.status === 'FAILURE').length;

        console.log(`Checks:\n${JSON.stringify(result.checks, null, 2)}`);

        console.log(`\nTest Results:`);
        console.log(`Passed: ${passed}/${denominator}, ${failed} failed`);

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
        console.error('Server test runner error:', error);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}