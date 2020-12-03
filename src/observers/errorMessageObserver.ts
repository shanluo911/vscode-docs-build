import vscode from 'vscode';
import { EventType } from '../common/eventType';
import { BaseEvent, UserSignInFailed, UserSignInCompleted, UserSignOutCompleted, UserSignOutFailed, BuildCompleted, BuildFailed } from '../common/loggingEvents';
import { MessageAction, EXTENSION_NAME, USER_TYPE, UserType } from '../shared';
import { ErrorCode } from '../error/errorCode';
import { DocsError } from '../error/docsError';
import { DocfxExecutionResult } from '../build/buildResult';

export class ErrorMessageObserver {
    public eventHandler = (event: BaseEvent) => {
        switch (event.type) {
            case EventType.UserSignInCompleted:
                if (!(<UserSignInCompleted>event).succeeded) {
                    let asUserSignInFailed = <UserSignInFailed>event;
                    this.showErrorMessage(`Signing in failed: ${asUserSignInFailed.err.message}`);
                }
                break;
            case EventType.UserSignOutCompleted:
                if (!(<UserSignOutCompleted>event).succeeded) {
                    let asUserSignOutFailed = <UserSignOutFailed>event;
                    this.showErrorMessage(`Signing out failed: ${asUserSignOutFailed.err.message}`);
                }
                break;
            case EventType.BuildCompleted:
                if ((<BuildCompleted>event).result === DocfxExecutionResult.Failed) {
                    this.handleBuildFailed(<BuildFailed>event);
                }
                break;
            case EventType.PublicUserSignIn:
                this.handlePublicUserSignIn();
                break;
            case EventType.TriggerCommandWithUnkownUserType:
                this.handleCommandWithUnkownUserTypeTriggered();
                break;
        }
    }

    private async showErrorMessage(message: string, ...actions: MessageAction[]) {
        let errorMsg = `[Docs Validation] ${message}`;
        actions.forEach((action) => {
            if (action && action.description) {
                errorMsg += ` ${action.description}`;
            }
        });
        let input = <MessageAction>(await vscode.window.showErrorMessage(errorMsg, ...actions));
        if (input) {
            if (input.command) {
                vscode.commands.executeCommand(input.command, undefined);
            } else if (input.callback) {
                input.callback(input.args);
            }
        }
    }

    private handleBuildFailed(event: BuildFailed) {
        let action: MessageAction;
        let error = <DocsError>event.err;
        switch (error.code) {
            case ErrorCode.TriggerBuildWithCredentialExpired:
                action = new MessageAction('Sign in', 'docs.signIn');
                break;
        }
        this.showErrorMessage(`Repository validation failed. ${event.err.message} Check the channel output for details`, action);
    }

    private handlePublicUserSignIn() {
        this.showErrorMessage(`Sign in is only available for Microsoft employees.`);
    }

    private handleCommandWithUnkownUserTypeTriggered() {
        this.showErrorMessage(
            `The command you triggered needs user type information. Please choose either Microsoft employee or Public contributor. ` +
            `You can change your selection later if needed in the extension settings (Docs validation -> User type).`,
            new MessageAction(
                "Microsoft employee",
                undefined,
                undefined,
                () => {
                    const extensionConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(EXTENSION_NAME, undefined);
                    extensionConfig.update(USER_TYPE, UserType.MicrosoftEmployee, true);
                }
            ),
            new MessageAction(
                "Public contributor",
                undefined,
                undefined,
                () => {
                    const extensionConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(EXTENSION_NAME, undefined);
                    extensionConfig.update(USER_TYPE, UserType.PublicContributor, true);
                }
            ));
    }
}
