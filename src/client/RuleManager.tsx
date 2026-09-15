/** Rule catalog entry point. */
import { createElement } from 'react'
import { ResourceManager } from './ResourceManager.tsx'
import type { TaskEngineRemote } from './TaskEngineSection.tsx'
export function RuleManager(props: { workspace: string; remote: TaskEngineRemote }) {
  return createElement(ResourceManager, { ...props, key: props.workspace, kind: 'rule' })
}
