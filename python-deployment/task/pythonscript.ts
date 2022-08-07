import * as fs from 'fs';
import * as path from 'path';

import * as task from 'azure-pipelines-task-lib/task';
import { AzureRMEndpoint } from 'azure-pipelines-tasks-azure-arm-rest-v2/azure-arm-endpoint';

import { v4 as uuidV4 } from 'uuid';

interface TaskParameters {
    serviceName: string,
    scriptSource: string,
    scriptPath?: string,
    script?: string,
    arguments?: string,
    pythonInterpreter?: string,
    workingDirectory?: string,
    failOnStderr?: boolean
}

/**
 * Check for a parameter at runtime.
 * Useful for conditionally-visible, required parameters.
 */
function assertParameter<T>(value: T | undefined, propertyName: string): T {
    if (!value) {
        throw new Error(task.loc('ParameterRequired', propertyName));
    }

    return value!;
}

export async function pythonScript(parameters: Readonly<TaskParameters>): Promise<void> {
    // Get the script to run
    const scriptPath = await (async () => {
        if (parameters.scriptSource.toLowerCase() === 'filepath') { // Run script file
            const scriptPath = assertParameter(parameters.scriptPath, 'scriptPath');

            if (!fs.statSync(scriptPath).isFile()) {
                throw new Error(task.loc('NotAFile', scriptPath));
            }
            return scriptPath;
        } else { // Run inline script
            const script = assertParameter(parameters.script, 'script');

            // Write the script to disk
            task.assertAgent('2.115.0');
            const tempDirectory = task.getVariable('agent.tempDirectory') || "";
            task.checkPath(tempDirectory, `${tempDirectory} (agent.tempDirectory)`);
            const scriptPath = path.join(tempDirectory, `${uuidV4()}.py`);
            await fs.writeFileSync(
                scriptPath,
                script,
                { encoding: 'utf8' });

            return scriptPath;
        }
    })();

    // Create the tool runner
    const pythonPath = parameters.pythonInterpreter || task.which('python');
    const python = task.tool(pythonPath).arg(scriptPath);

    // Set AUTH parameters
    const endpointObject = await new AzureRMEndpoint(parameters.serviceName).getEndpoint();
    const subscription = endpointObject.subscriptionID!
    const tenant = endpointObject.tenantID!
    const client_id = endpointObject.servicePrincipalClientID!
    const client_secret = endpointObject.servicePrincipalKey!

    let args = `"--subscription=${subscription}" "--tenant=${tenant}" "--client_id=${client_id}" "--client_secret=${client_secret}" `
    if (parameters.arguments) {
        args += parameters.arguments
    }
    python.line(args)

    // Run the script
    // Use `any` to work around what I suspect are bugs with `IExecOptions`'s type annotations:
    // - optional fields need to be typed as optional
    // - `errStream` and `outStream` should be `NodeJs.WritableStream`, not `NodeJS.Writable`
    await python.exec(<any>{
        cwd: parameters.workingDirectory,
        failOnStdErr: parameters.failOnStderr,
        // Direct all output to stdout, otherwise the output may appear out-of-order since Node buffers its own stdout but not stderr
        errStream: process.stdout,
        outStream: process.stdout,
        ignoreReturnCode: false
    });
}