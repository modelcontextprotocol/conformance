export type CheckStatus = 'SUCCESS' | 'FAILURE' | 'WARNING' | 'SKIPPED' | 'INFO';

export interface SpecReference {
    id: string;
    url?: string;
}

export interface ConformanceCheck {
    id: string;
    name: string;
    description: string;
    status: CheckStatus;
    timestamp: string;
    specReferences?: SpecReference[];
    details?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    errorMessage?: string;
    logs?: string[];
}

export interface ScenarioUrls {
    serverUrl: string;
    authUrl?: string;
}

export interface Scenario {
    name: string;
    description: string;
    start(): Promise<ScenarioUrls>;
    stop(): Promise<void>;
    getChecks(): ConformanceCheck[];
}
