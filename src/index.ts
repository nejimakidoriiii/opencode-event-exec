import { spawn } from "node:child_process"
import { createEventExecPlugin } from "./plugin.js"

export default createEventExecPlugin({ spawn })
