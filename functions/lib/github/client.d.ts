interface GithubClient {
    users: {
        getAuthenticated(): Promise<{
            data: {
                login: string;
                id: number;
                type: string;
            };
            headers: Record<string, string | number | string[] | undefined>;
        }>;
    };
    orgs: {
        get(input: {
            org: string;
        }): Promise<{
            data: {
                login?: string;
                members_can_create_repositories?: boolean;
                default_repository_permission?: string;
            };
        }>;
        getMembershipForAuthenticatedUser(input: {
            org: string;
        }): Promise<{
            data: {
                state?: string;
                role?: string;
            };
        }>;
    };
    repos: {
        getContent(input: {
            owner: string;
            repo: string;
            path: string;
        }): Promise<{
            data: Array<unknown> | {
                sha?: string;
                content?: string;
                encoding?: string;
                type?: string;
            };
        }>;
        createInOrg(input: {
            org: string;
            name: string;
            description: string;
            private: boolean;
            has_issues: boolean;
            has_projects: boolean;
            has_wiki: boolean;
            auto_init: boolean;
            license_template: string;
        }): Promise<{
            data: {
                name: string;
                html_url: string;
            };
        }>;
        delete(input: {
            owner: string;
            repo: string;
        }): Promise<unknown>;
        createOrUpdateFileContents(input: {
            owner: string;
            repo: string;
            path: string;
            message: string;
            content: string;
            branch: string;
            sha?: string;
        }): Promise<unknown>;
    };
    actions: {
        createWorkflowDispatch(input: {
            owner: string;
            repo: string;
            workflow_id: string;
            ref: string;
            inputs: Record<string, string>;
        }): Promise<unknown>;
    };
}
export declare function getGithubClient(): Promise<GithubClient>;
export {};
