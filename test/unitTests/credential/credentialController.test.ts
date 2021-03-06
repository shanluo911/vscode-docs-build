import assert from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import vscode from 'vscode';

import { BuildType } from '../../../src/build/buildInput';
import { DocfxExecutionResult } from '../../../src/build/buildResult';
import { EnvironmentController } from '../../../src/common/environmentController';
import { EventStream } from '../../../src/common/eventStream';
import { BaseEvent, BuildCompleted,BuildFailed, CredentialExpired, CredentialReset, EnvironmentChanged, PublicContributorSignIn, StartLanguageServerCompleted, UserSignInFailed, UserSignInProgress, UserSignInSucceeded, UserSignInTriggered, UserSignOutSucceeded, UserSignOutTriggered } from '../../../src/common/loggingEvents';
import extensionConfig from '../../../src/config';
import { Credential,CredentialController } from '../../../src/credential/credentialController';
import { KeyChain } from '../../../src/credential/keyChain';
import { DocsError } from '../../../src/error/docsError';
import { ErrorCode } from '../../../src/error/errorCode';
import { TimeOutError } from '../../../src/error/timeOutError';
import { OP_BUILD_USER_TOKEN_HEADER_NAME,SignInReason, uriHandler, UserInfo, UserType } from '../../../src/shared';
import { fakedCredential,getFakeEnvironmentController, setupKeyChain } from '../../utils/faker';
import TestEventBus from '../../utils/testEventBus';

const fakedGitHubCallbackURL = <vscode.Uri>{
    authority: 'docsmsft.docs-build',
    path: '/github-authenticate',
    query: `id=faked-github-id&name=Fake-User-GitHub&email=fake-github@microsoft.com&${OP_BUILD_USER_TOKEN_HEADER_NAME}=fake-github-token`
};

const fakedAzureDevOpsCallbackURL = <vscode.Uri>{
    authority: 'docsmsft.docs-build',
    path: '/azure-devops-authenticate',
    query: `id=faked-azure-devops-id&name=Fake-User-Azure-DevOps&email=fake-azure-devops@microsoft.com&${OP_BUILD_USER_TOKEN_HEADER_NAME}=fake-azure-devops-token`
};

const fakedCorrelationId = 'fakedCorrelationId';

describe('CredentialController', () => {
    let sinon: SinonSandbox;
    let stubGetUserInfo: SinonStub;
    let stubCredentialControllerInitialize: SinonStub;
    let stubOpenExternal: SinonStub;
    let stubConfigTimeout: SinonStub;

    let eventStream: EventStream;
    let environmentController: EnvironmentController;
    let keyChain: KeyChain;
    let credentialController: CredentialController;
    let testEventBus: TestEventBus;

    let setUserInfo: UserInfo;
    let isSetUserInfoCalled: boolean;
    let isResetUserInfoCalled: boolean;
    let isCredentialControllerInitializeCalled: boolean;

    before(() => {
        eventStream = new EventStream();
        environmentController = getFakeEnvironmentController('GitHub');
        keyChain = new KeyChain(environmentController);
        credentialController = new CredentialController(keyChain, eventStream, environmentController);
        testEventBus = new TestEventBus(eventStream);

        sinon = createSandbox();
        sinon.stub(keyChain, 'setUserInfo').callsFake(function (userInfo: UserInfo): Promise<void> {
            isSetUserInfoCalled = true;
            setUserInfo = userInfo;
            return;
        });
        sinon.stub(keyChain, 'resetUserInfo').callsFake(function (): Promise<void> {
            isResetUserInfoCalled = true;
            return;
        });
    });

    beforeEach(() => {
        isSetUserInfoCalled = false;
        isResetUserInfoCalled = false;
        setUserInfo = undefined;
        testEventBus.clear();
    });

    afterEach(() => {
        stubGetUserInfo && stubGetUserInfo.restore();
        stubConfigTimeout && stubConfigTimeout.restore();
        stubOpenExternal && stubOpenExternal.restore();
        stubCredentialControllerInitialize && stubCredentialControllerInitialize.restore();
    });

    after(() => {
        sinon.restore();
        testEventBus.dispose();
    });

    function setupAvailableKeyChain() {
        stubGetUserInfo = setupKeyChain(sinon, keyChain, fakedCredential.userInfo);
    }

    function setupUnavailableKeyChain() {
        stubGetUserInfo = setupKeyChain(sinon, keyChain, undefined);
    }

    function AssertCredentialReset(credential: Credential) {
        assert.equal(isResetUserInfoCalled, true);
        assert.deepStrictEqual(credential, <Credential>{
            signInStatus: 'SignedOut',
            userInfo: undefined
        });
    }

    [
        new EnvironmentChanged('PPE')
    ].forEach((event: BaseEvent) => {
        describe(`Observer[${event.constructor.name}]: Credential should be refreshed`, () => {
            beforeEach(() => {
                stubCredentialControllerInitialize = sinon.stub(credentialController, 'initialize').callsFake(function (): Promise<void> {
                    isCredentialControllerInitializeCalled = true;
                    return;
                });

                isCredentialControllerInitializeCalled = false;
            });

            it(`CredentialController Initialize should be Called`, () => {
                credentialController.eventHandler(event);

                assert.equal(isCredentialControllerInitializeCalled, true);
            });
        });
    });

    it('CredentialExpired: Credential should be reset', () => {
        const event = new CredentialExpired();
        credentialController.eventHandler(event);

        const credential = credentialController.credential;
        AssertCredentialReset(credential);
        assert.deepStrictEqual(testEventBus.getEvents(), [new CredentialReset()]);
    });

    describe(`Initialize`, () => {
        it(`Should be 'SignedIn' status if the user info can be retrieved from keyChain`, async () => {
            // Prepare
            setupAvailableKeyChain();

            // Act
            await credentialController.initialize(fakedCorrelationId);

            // Assert
            const credential = credentialController.credential;
            assert.deepStrictEqual(credential, fakedCredential);
            assert.deepStrictEqual(testEventBus.getEvents(), [new UserSignInSucceeded(fakedCorrelationId, fakedCredential, true)]);
        });

        it(`Should be 'SignedOut' status if the user info can not be retrieved from keyChain`, async () => {
            // Prepare
            setupUnavailableKeyChain();

            // Act
            await credentialController.initialize(fakedCorrelationId);

            // Assert
            const credential = credentialController.credential;
            AssertCredentialReset(credential);
            assert.deepStrictEqual(testEventBus.getEvents(), [new CredentialReset()]);
        });

        it(`Should be 'SignedOut' status if the user type is not Microsoft employee`, async () => {
            const stubUserType = sinon.stub(environmentController, 'userType').get(() => {
                return UserType.PublicContributor;
            });

            // Act
            await credentialController.initialize(fakedCorrelationId);

            // Assert
            const credential = credentialController.credential;
            AssertCredentialReset(credential);
            assert.deepStrictEqual(testEventBus.getEvents(), [new CredentialReset()]);
            stubUserType.restore();
        });
    });

    describe(`Public contributor`, () => {
        const tempEventStream = new EventStream();
        const tempEnvironmentController = <EnvironmentController>{
            env: 'PROD',
            docsRepoType: 'GitHub',
            debugMode: false,
            userType: UserType.PublicContributor
        };
        const tempCredentialController = new CredentialController(keyChain, tempEventStream, tempEnvironmentController);
        const tempEventBus = new TestEventBus(tempEventStream);
        it(`Public contributor sign-in`, async () => {
            await tempCredentialController.signIn(fakedCorrelationId);
            assert.deepStrictEqual(tempEventBus.getEvents(), [new PublicContributorSignIn()]);
        });
    });

    describe(`Handle validation failed events`, () => {
        let tempCredentialController: CredentialController;
        const signInError = new DocsError('error', ErrorCode.TriggerBuildBeforeSignIn);
        const notSignInError = new DocsError('error', ErrorCode.TriggerBuildOnInvalidDocsRepo);

        beforeEach(() => {
            tempCredentialController = new CredentialController(keyChain, eventStream, environmentController);
        });

        it(`Handle build succeeded`, () => {
            tempCredentialController.eventHandler(new BuildCompleted(fakedCorrelationId, DocfxExecutionResult.Succeeded, undefined, BuildType.FullBuild, 1));
            assertSignInReason(undefined);
        });

        it(`Handle build failed not caused by sign in error`, () => {
            tempCredentialController.eventHandler(new BuildFailed(fakedCorrelationId, undefined, BuildType.FullBuild, 1, notSignInError));
            assertSignInReason(undefined);
        });

        it(`Handle build failed caused by sign in error`, () => {
            tempCredentialController.eventHandler(new BuildFailed(fakedCorrelationId, undefined, BuildType.FullBuild, 1, signInError));
            assertSignInReason('FullRepoValidation');
        });

        it(`Handle start server succeeded`, () => {
            tempCredentialController.eventHandler(new StartLanguageServerCompleted(true));
            assertSignInReason(undefined);
        });

        it(`Handle start server failed not caused by sign in error`, () => {
            tempCredentialController.eventHandler(new StartLanguageServerCompleted(false, notSignInError));
            assertSignInReason(undefined);
        });

        it(`Handle start server failed caused by sign in error`, () => {
            tempCredentialController.eventHandler(new StartLanguageServerCompleted(false, signInError));
            assertSignInReason('RealTimeValidation');
        });

        it(`Handle credential expiry during language server is running`, () => {
            tempCredentialController.eventHandler(new CredentialExpired(true));
            const credential = credentialController.credential;
            AssertCredentialReset(credential);
            assertSignInReason('RealTimeValidation');
        });


        function assertSignInReason(reason: SignInReason) {
            // @ts-ignore
            assert.equal(tempCredentialController._signInReason, reason);
        }
    });

    describe(`User Sign-in With GitHub`, () => {
        const signInError = new DocsError('errorMessage', ErrorCode.TriggerBuildBeforeSignIn);
        const expectedUserInfo = <UserInfo>{
            signType: 'GitHub',
            userId: 'faked-github-id',
            userEmail: 'fake-github@microsoft.com',
            userName: 'Fake-User-GitHub',
            userToken: 'fake-github-token'
        };
        const expectedCredential = <Credential>{
            signInStatus: 'SignedIn',
            userInfo: expectedUserInfo
        };
        it(`Sign-in successfully`, async () => {
            // Prepare
            stubOpenExternal = sinon.stub(vscode.env, 'openExternal').callsFake(
                function (target: vscode.Uri): Thenable<boolean> {
                    return new Promise((resolve, reject) => {
                        setTimeout(() => {
                            uriHandler.handleUri(fakedGitHubCallbackURL);
                        }, 10);
                        resolve(true);
                    });
                }
            );

            // act
            await credentialController.signIn(fakedCorrelationId);

            // Assert
            const credential = credentialController.credential;
            assert.deepStrictEqual(credential, expectedCredential);
            assert.equal(isSetUserInfoCalled, true);
            assert.deepStrictEqual(setUserInfo, expectedUserInfo);
            assert.deepStrictEqual(testEventBus.getEvents(), [
                new CredentialReset(),
                new UserSignInTriggered(fakedCorrelationId),
                new UserSignInProgress(`Signing in to Docs with GitHub account...`, 'Sign-in'),
                new UserSignInSucceeded(fakedCorrelationId, expectedCredential, false)
            ]);
        });

        it(`Sign-in successfully with sign-in reason`, async () => {
            // Prepare
            stubOpenExternal = sinon.stub(vscode.env, 'openExternal').callsFake(
                function (target: vscode.Uri): Thenable<boolean> {
                    return new Promise((resolve, reject) => {
                        setTimeout(() => {
                            uriHandler.handleUri(fakedGitHubCallbackURL);
                        }, 10);
                        resolve(true);
                    });
                }
            );
            credentialController.eventHandler(new StartLanguageServerCompleted(false, signInError));

            // act
            await credentialController.signIn(fakedCorrelationId);

            // Assert
            assert.deepStrictEqual(testEventBus.getEvents(), [
                new CredentialReset(),
                new UserSignInTriggered(fakedCorrelationId),
                new UserSignInProgress(`Signing in to Docs with GitHub account...`, 'Sign-in'),
                new UserSignInSucceeded(fakedCorrelationId, expectedCredential, false, 'RealTimeValidation')
            ]);
        });

        it(`Sign-in with GitHub failed`, async () => {
            // Prepare
            stubOpenExternal = sinon.stub(vscode.env, 'openExternal').resolves(false);

            // Act
            await credentialController.signIn(fakedCorrelationId);

            // Assert
            const credential = credentialController.credential;
            AssertCredentialReset(credential);
            assert.deepStrictEqual(testEventBus.getEvents(), [
                new CredentialReset(),
                new UserSignInTriggered(fakedCorrelationId),
                new UserSignInProgress(`Signing in to Docs with GitHub account...`, 'Sign-in'),
                new CredentialReset(),
                new UserSignInFailed(fakedCorrelationId, new DocsError(`Signing in with GitHub failed: please allow to open external URL to sign in`, ErrorCode.GitHubSignInExternalUrlDeclined)),
            ]);
        });

        it(`Sign-in with GitHub timed out`, async () => {
            // Prepare
            // Mock sign-in timeout config to 200ms.
            stubConfigTimeout = sinon.stub(extensionConfig, 'SignInTimeOut').get(() => {
                return 200;
            });
            stubOpenExternal = sinon.stub(vscode.env, 'openExternal').resolves(true);

            // Act
            await credentialController.signIn(fakedCorrelationId);

            // Assert
            const credential = credentialController.credential;
            AssertCredentialReset(credential);
            assert.deepStrictEqual(testEventBus.getEvents(), [
                new CredentialReset(),
                new UserSignInTriggered(fakedCorrelationId),
                new UserSignInProgress(`Signing in to Docs with GitHub account...`, 'Sign-in'),
                new CredentialReset(),
                new UserSignInFailed(fakedCorrelationId, new DocsError(`Signing in with GitHub failed: Timed out`, ErrorCode.GitHubSignInTimeOut, new TimeOutError('Timed out'))),
            ]);
        });
    });

    describe(`User signing in With Azure DevOps`, () => {
        before(() => { environmentController.docsRepoType = 'Azure DevOps'; });

        it(`Sign in successfully`, async () => {
            // Prepare
            stubOpenExternal = sinon.stub(vscode.env, 'openExternal').callsFake(
                function (target: vscode.Uri): Thenable<boolean> {
                    return new Promise((resolve, reject) => {
                        setTimeout(() => {
                            uriHandler.handleUri(fakedAzureDevOpsCallbackURL);
                        }, 10);
                        resolve(true);
                    });
                }
            );

            // act
            await credentialController.signIn(fakedCorrelationId);

            // Assert
            const credential = credentialController.credential;
            const expectedUserInfo = <UserInfo>{
                signType: 'Azure DevOps',
                userId: 'faked-azure-devops-id',
                userEmail: 'fake-azure-devops@microsoft.com',
                userName: 'Fake-User-Azure-DevOps',
                userToken: 'fake-azure-devops-token'
            };
            const expectedCredential = <Credential>{
                signInStatus: 'SignedIn',
                userInfo: expectedUserInfo
            };
            assert.deepStrictEqual(credential, expectedCredential);
            assert.equal(isSetUserInfoCalled, true);
            assert.deepStrictEqual(setUserInfo, expectedUserInfo);
            assert.deepStrictEqual(testEventBus.getEvents(), [
                new CredentialReset(),
                new UserSignInTriggered(fakedCorrelationId),
                new UserSignInProgress(`Signing in to Docs with Azure DevOps account...`, 'Sign-in'),
                new UserSignInSucceeded(fakedCorrelationId, expectedCredential)
            ]);
        });

        it(`Signing in with Azure DevOps failed`, async () => {
            // Prepare
            stubOpenExternal = sinon.stub(vscode.env, 'openExternal').resolves(false);

            // Act
            await credentialController.signIn(fakedCorrelationId);

            // Assert
            const credential = credentialController.credential;
            AssertCredentialReset(credential);
            assert.deepStrictEqual(testEventBus.getEvents(), [
                new CredentialReset(),
                new UserSignInTriggered(fakedCorrelationId),
                new UserSignInProgress(`Signing in to Docs with Azure DevOps account...`, 'Sign-in'),
                new CredentialReset(),
                new UserSignInFailed(fakedCorrelationId, new DocsError(`Signing in with Azure DevOps failed: please allow to open external URL to sign in`, ErrorCode.AzureDevOpsSignInExternalUrlDeclined)),
            ]);
        });

        it(`Signing in with Azure DevOps timed out`, async () => {
            // Prepare
            // Mock sign-in timeout config to 200ms.
            stubConfigTimeout = sinon.stub(extensionConfig, 'SignInTimeOut').get(() => {
                return 200;
            });
            stubOpenExternal = sinon.stub(vscode.env, 'openExternal').resolves(true);

            // Act
            await credentialController.signIn(fakedCorrelationId);

            // Assert
            const credential = credentialController.credential;
            AssertCredentialReset(credential);
            assert.deepStrictEqual(testEventBus.getEvents(), [
                new CredentialReset(),
                new UserSignInTriggered(fakedCorrelationId),
                new UserSignInProgress(`Signing in to Docs with Azure DevOps account...`, 'Sign-in'),
                new CredentialReset(),
                new UserSignInFailed(fakedCorrelationId, new DocsError(`Signing in with Azure DevOps failed: Timed out`, ErrorCode.AzureDevOpsSignInTimeOut, new TimeOutError('Timed out'))),
            ]);
        });
    });

    it(`User sign-out`, async () => {
        // Sign-in first
        setupAvailableKeyChain();
        await credentialController.initialize(fakedCorrelationId);

        // Act - Sign-out
        credentialController.signOut(fakedCorrelationId);

        // Assert
        const credential = credentialController.credential;
        AssertCredentialReset(credential);
        assert.deepStrictEqual(testEventBus.getEvents(), [
            new UserSignInSucceeded(fakedCorrelationId, fakedCredential, true),
            new UserSignOutTriggered(fakedCorrelationId),
            new CredentialReset(),
            new UserSignOutSucceeded(fakedCorrelationId)
        ]);
    });
});