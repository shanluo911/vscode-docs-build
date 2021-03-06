import assert from 'assert';
import fs from 'fs-extra';
import path from 'path';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import { Diagnostic, DiagnosticSeverity, Range,Uri } from 'vscode';

import { DiagnosticController } from '../../../src/build/diagnosticController';
import { visualizeBuildReport } from '../../../src/build/reportGenerator';
import { EventStream } from '../../../src/common/eventStream';
import { BuildProgress } from '../../../src/common/loggingEvents';
import TestEventBus from '../../utils/testEventBus';

describe("ReportGenerator", () => {
    const testRepositoryPath = path.resolve(__dirname, "fakedFolder");
    const testLogPath = path.resolve(__dirname, ".errors.log");
    const fakedErrorLog = `{"message_severity":"info","log_item_type":"user","code":"test-info","message":"message for test info","file":"index.md","line":1,"end_line":1,"column":1,"end_column":1,"date_time":"2020-03-04T08:43:12.3284386Z","document_url":"https://test-document"}\n`
        + `{"message_severity":"warning","log_item_type":"user","code":"test-warning","message":"message for test warning","file":"index.md","line":1,"end_line":1,"column":1,"end_column":1,"date_time":"2020-03-04T08:43:12.3284386Z"}\n`
        + `{"message_severity":"error","log_item_type":"user","code":"test-error","message":"message for test error","file":"index.md","line":1,"end_line":1,"column":1,"end_column":1,"date_time":"2020-03-04T08:43:12.3284386Z"}\n`;
    let eventStream: EventStream;
    let testEventBus: TestEventBus;

    let sinon: SinonSandbox;
    let stubFsExistsSync: SinonStub;
    let stubFsReadFileSync: SinonStub;

    let diagnosticSet: {
        [key: string]: any;
    } = {};
    const fakedDiagnosticController = <DiagnosticController>{
        reset: () => {
            diagnosticSet = {};
        },
        setDiagnostic: (uri: Uri, diagnostics: Diagnostic[]) => {
            diagnosticSet[uri.fsPath] = {
                uri,
                diagnostics
            };
        }
    };

    const expectedInfoDiagnostic = new Diagnostic(new Range(0, 0, 0, 0), `message for test info`, DiagnosticSeverity.Hint);
    const expectedWarningDiagnostic = new Diagnostic(new Range(0, 0, 0, 0), `message for test warning`, DiagnosticSeverity.Warning);
    const expectedErrorDiagnostic = new Diagnostic(new Range(0, 0, 0, 0), `message for test error`, DiagnosticSeverity.Error);
    expectedInfoDiagnostic.code = {
        value: 'test-info',
        target: Uri.parse("https://test-document"),
    };
    expectedInfoDiagnostic.source = 'Docs Validation';
    expectedWarningDiagnostic.code = {
        value: 'test-warning',
        target: Uri.parse("https://review.docs.microsoft.com/en-us/help/contribute/validation-ref/doc-not-available"),
    };
    expectedWarningDiagnostic.source = 'Docs Validation';
    expectedErrorDiagnostic.code = {
        value: 'test-error',
        target: Uri.parse("https://review.docs.microsoft.com/en-us/help/contribute/validation-ref/doc-not-available"),
    };
    expectedErrorDiagnostic.source = 'Docs Validation';
    const expectedFileUri = Uri.file(`${testRepositoryPath}/index.md`);
    expectedFileUri.fsPath;

    before(() => {
        eventStream = new EventStream();
        testEventBus = new TestEventBus(eventStream);
        sinon = createSandbox();

        stubFsExistsSync = sinon.stub(fs, "existsSync");
        stubFsReadFileSync = sinon.stub(fs, "readFileSync");
    });

    beforeEach(() => {
        testEventBus.clear();
    });

    after(() => {
        sinon.restore();
        testEventBus.dispose();
    });

    describe("No validation result", () => {
        before(() => {
            stubFsExistsSync
                .withArgs(path.normalize(testLogPath))
                .returns(false);
        });

        it("When there is no diagnostics in last build", () => {
            diagnosticSet = {};
            visualizeBuildReport(testRepositoryPath, testLogPath, fakedDiagnosticController, eventStream);

            assert.deepStrictEqual(diagnosticSet, {});
            assert.deepStrictEqual(testEventBus.getEvents(), [
                new BuildProgress(`Log file (.error.log) not found. Skip generating report`)
            ]);
        });

        it("When there is some diagnostics in last build", () => {
            diagnosticSet = {
                "testPath": {}
            };
            visualizeBuildReport(testRepositoryPath, testLogPath, fakedDiagnosticController, eventStream);

            assert.deepStrictEqual(diagnosticSet, {});
            assert.deepStrictEqual(testEventBus.getEvents(), [
                new BuildProgress(`Log file (.error.log) not found. Skip generating report`)
            ]);
        });
    });

    it("Report found", () => {
        stubFsExistsSync
            .withArgs(path.normalize(testLogPath)).returns(true);
        stubFsReadFileSync
            .withArgs(path.normalize(testLogPath)).returns(fakedErrorLog);

        visualizeBuildReport(testRepositoryPath, testLogPath, fakedDiagnosticController, eventStream);

        assert.deepStrictEqual(diagnosticSet, {
            [path.normalize(`${testRepositoryPath}/index.md`)]: {
                uri: expectedFileUri,
                diagnostics: [
                    expectedInfoDiagnostic,
                    expectedWarningDiagnostic,
                    expectedErrorDiagnostic
                ]
            },
        });
        assert.deepStrictEqual(testEventBus.getEvents(), [
            new BuildProgress(`Log file found, Generating report...`),
        ]);
    });

    it("Handle pull_request_only diagnostics", () => {
        const fakedErrorLogWithPullRequest = `{"message_severity":"info","log_item_type":"user","code":"test-info","message":"message for test info","file":"index.md","line":1,"end_line":1,"column":1,"end_column":1,"date_time":"2020-03-04T08:43:12.3284386Z","document_url":"https://test-document","pull_request_only":true}\n`
            + `{"message_severity":"warning","log_item_type":"user","code":"test-warning","message":"message for test warning","file":"index.md","line":1,"end_line":1,"column":1,"end_column":1,"date_time":"2020-03-04T08:43:12.3284386Z","pull_request_only":false}\n`
            + `{"message_severity":"error","log_item_type":"user","code":"test-error","message":"message for test error","file":"index.md","line":1,"end_line":1,"column":1,"end_column":1,"date_time":"2020-03-04T08:43:12.3284386Z","pull_request_only":null}\n`;
        stubFsExistsSync
            .withArgs(path.normalize(testLogPath)).returns(true);
        stubFsReadFileSync
            .withArgs(path.normalize(testLogPath)).returns(fakedErrorLogWithPullRequest);

        visualizeBuildReport(testRepositoryPath, testLogPath, fakedDiagnosticController, eventStream);
        assert.deepStrictEqual(diagnosticSet, {
            [path.normalize(`${testRepositoryPath}/index.md`)]: {
                uri: expectedFileUri,
                diagnostics: [
                    expectedWarningDiagnostic,
                    expectedErrorDiagnostic
                ]
            },
        });
        assert.deepStrictEqual(testEventBus.getEvents(), [
            new BuildProgress(`Log file found, Generating report...`),
        ]);
    });

    it("Handle diagnostic with no source file", () => {
        const configFile = '.openpublishing.publish.config.json';
        const configPath = `${testRepositoryPath}/${configFile}`;
        const configUri = Uri.file(configPath);
        configUri.fsPath;
        const fakedErrorLogWithPullRequest = `{"message_severity":"warning","log_item_type":"user","code":"test-warning","message":"message for test warning","line":1,"end_line":1,"column":1,"end_column":1,"date_time":"2020-03-04T08:43:12.3284386Z"}\n`;
        stubFsExistsSync
            .withArgs(path.normalize(testLogPath)).returns(true);
        stubFsReadFileSync
            .withArgs(path.normalize(testLogPath)).returns(fakedErrorLogWithPullRequest);

        visualizeBuildReport(testRepositoryPath, testLogPath, fakedDiagnosticController, eventStream);
        assert.deepStrictEqual(diagnosticSet, {
            [path.normalize(configPath)]: {
                uri: configUri,
                diagnostics: [
                    expectedWarningDiagnostic
                ]
            },
        });
        assert.deepStrictEqual(testEventBus.getEvents(), [
            new BuildProgress(`Log file found, Generating report...`),
        ]);
    });
}); 