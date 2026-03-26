# Loop Extender
Loop Extender (loopx) is a simple command line tool meant to automate ralph loops around agent CLIs. Instead of 
```bash
while :; do cat PROMPT.md | claude --dangerously-skip-permissions -p ; done
```
loopx can perform this natively (exact syntax isn't specified by this document but it could be thought of logically like `loopx cat PROMPT.md | claude --dangerously-skip-permissions -p`)

loopx is also scriptable. The scripting capabilities are laid out below.

# Scripting
Scripts are located in the `.loopx` directory in the PWD. loopx knows which script to run based on its name. Scripts can be written in bash (.sh), JavaScript (.js/.jsx), or TypeScript (.ts/.tsx). If multiple files with different extensions but the same name i.e. example.sh AND example.js exist then loopx refuses to run and displays an error message to the user.

Let's say you have a script called myscript.ts. This can be run via `loopx myscript`. The script named "default" can be invoked without a name (just `loopx`).

## Outputs
Scripts return a structured JSON with three optional fields.
```typescript
{
  result?: string,
  goto?: string,
  stop?: boolean
}
```
loopx can generate this output for bash script like `loopx output --result ... --goto ... --stop ...`

If stop is true, then the loop exits.

If goto is present, it names the next script that is executed after the current one is returned. If it is absent, then the loop starts over at whatever the initial starting point was.

If result is present, its content is printed and piped into the next script according to goto. If goto, is not present, the output is not piped into anything.

loopx is an executable cli implemented in TypeScript. It can be installed as a package and imported into TS/JS scripts.

```typescript
import { output } from "loopx";
// also exports and interface for the output type, if needed
import type { Output } from "loopx";

output(/* ... */) // exits script and returns this value to stdout
```
If output does not conform to the output schema, then it is treated as the content of result (with no goto or stop). In this way, you could loop a simple ralph style command without adding extra steps for the schema.

## Invocation
loopx can easily be invoked from the command line. It can also be invoked from JS/TS like this:
```typescript
import { run /* or runPromise */ } from "loopx";
run("myscriptname");
```
Run is a generator that yields each output (TODO: determine if a generator is the proper structure here). runPromise just returns a promise that completes when the loop ends.

## Reserved Script Names
Scripts cannot use these names because it would conflict with other functionality. 
- output
- env
- install
- version

If any script uses a reserved name, an error is presented to the user and loopx refuses to start.

Scripts cannot begin with `-`.


# Version
`loopx version` just returns the version of loopx.

# Environment Variables
Scripts might need environment variables. There is a global directory created in the user's file system which stores environment variables. This allows env vars to be used across projects.
`loopx env set ENV_VAR_NAME ENV_VAR_VALUE`
`loopx env remove ENV_VAR_NAME`

# Install
`loopx install [url]` downloads a remote file to the .loop directory. The file must have an appropriate extension otherwise it will present an error to the user. 

# Options
`-n` is the max number of times that the loops is run. Example `loopx -n 15`
`-e` sets a specific env var file that is merged with the global env vars (local takes precedence in conflicts with global). Example `loopx -e .env`

# Help
`-h` or `--help` return help explaining usage in the normal way. It dynamically pulls in all scripts to show what is available to run in the cli.
