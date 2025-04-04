import type { CreateProjectResponse } from '@onlook/models';
import type { ImageMessageContext } from '@onlook/models/chat';
import { MainChannels } from '@onlook/models/constants';
import { makeAutoObservable } from 'mobx';
import { ProjectTabs, type ProjectsManager } from '.';
import { invokeMainChannel, sendAnalytics } from '../utils';

export enum CreateState {
    PROMPT = 'prompting',
    IMPORT = 'import',
    CREATE_LOADING = 'create-loading',
    ERROR = 'error',
}

const SLOW_CREATE_MESSAGES: { time: number; message: string }[] = [
    { time: 15000, message: 'Finalizing layout...' },
    { time: 30000, message: 'Drafting copy...' },
    { time: 45000, message: 'Finalizing design...' },
    { time: 60000, message: 'Completing setup...' },
    { time: 75000, message: 'Starting project...' },
];

export class CreateManager {
    createState: CreateState = CreateState.PROMPT;
    progress: number = 0;
    message: string | null = null;
    error: string | null = null;
    private cleanupListener: (() => void) | null = null;
    private slowConnectionTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private projectsManager: ProjectsManager) {
        makeAutoObservable(this);
        this.listenForPromptProgress();
    }

    private startSlowConnectionTimer() {
        if (this.slowConnectionTimer) {
            clearTimeout(this.slowConnectionTimer);
        }

        SLOW_CREATE_MESSAGES.forEach(({ time, message }) => {
            setTimeout(() => {
                if (this.state === CreateState.CREATE_LOADING) {
                    this.message = message;
                    this.progress += 10;
                }
            }, time);
        });

        this.slowConnectionTimer = setTimeout(
            () => {},
            Math.max(...SLOW_CREATE_MESSAGES.map((m) => m.time)),
        );
    }

    private clearSlowConnectionTimer() {
        if (this.slowConnectionTimer) {
            clearTimeout(this.slowConnectionTimer);
            this.slowConnectionTimer = null;
        }
    }

    listenForPromptProgress() {
        window.api.on(
            MainChannels.CREATE_NEW_PROJECT_PROMPT_CALLBACK,
            ({ message, progress }: { message: string; progress: number }) => {
                this.progress = progress;
                this.message = message;
            },
        );

        this.cleanupListener = () => {
            window.api.removeAllListeners(MainChannels.CREATE_NEW_PROJECT_PROMPT_CALLBACK);
        };

        return this.cleanupListener;
    }

    get state() {
        return this.createState;
    }

    set state(newState: CreateState) {
        this.createState = newState;
        if (newState === CreateState.CREATE_LOADING) {
            this.startSlowConnectionTimer();
        } else {
            this.clearSlowConnectionTimer();
        }
    }

    async sendPrompt(prompt: string, images: ImageMessageContext[], blank: boolean = false) {
        sendAnalytics('prompt create project', {
            prompt,
            blank,
        });

        this.state = CreateState.CREATE_LOADING;
        this.error = null;
        let result: CreateProjectResponse;

        if (blank) {
            result = await invokeMainChannel(MainChannels.CREATE_NEW_BLANK_PROJECT);
        } else {
            result = await invokeMainChannel(MainChannels.CREATE_NEW_PROJECT_PROMPT, {
                prompt,
                images,
            });
        }

        if (result.success && result.response?.projectPath) {
            this.state = CreateState.PROMPT;
            const newProject = this.createProject(result.response.projectPath);
            this.projectsManager.project = newProject;
            setTimeout(() => {
                this.projectsManager.projectsTab = ProjectTabs.PROJECTS;
            }, 100);

            // Generate suggestions
            if (!blank && result.response?.content) {
                this.projectsManager.editorEngine?.chat.suggestions.generateCreatedSuggestions(
                    prompt,
                    result.response.content,
                    images,
                );
            }

            this.clearSlowConnectionTimer();

            setTimeout(() => {
                this.projectsManager.runner?.startIfPortAvailable();
            }, 1000);
            sendAnalytics('prompt create project success');
        } else {
            this.error = result.error || 'Failed to create project';
            this.state = CreateState.ERROR;
            sendAnalytics('prompt create project error', {
                error: this.error,
            });
        }
    }

    createProject(projectPath: string) {
        const projectName = 'New Project';
        const projectUrl = 'http://localhost:3000';
        const projectCommands = {
            install: 'npm install',
            run: 'npm run dev',
            build: 'npm run build',
        };

        return this.projectsManager.createProject(
            projectName,
            projectUrl,
            projectPath,
            projectCommands,
        );
    }

    async cancel() {
        await invokeMainChannel(MainChannels.CANCEL_CREATE_NEW_PROJECT_PROMPT);
        this.state = CreateState.PROMPT;
    }

    cleanup() {
        if (this.cleanupListener) {
            this.cleanupListener();
            this.cleanupListener = null;
        }
        this.clearSlowConnectionTimer();
    }
}
