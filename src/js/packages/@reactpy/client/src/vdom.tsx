import type { ReactPyClientInterface } from "./types";
import serializeEvent from "event-to-object";
import type {
  ReactPyVdom,
  ReactPyVdomImportSource,
  ReactPyVdomEventHandler,
  ReactPyModule,
  BindImportSource,
  ReactPyModuleBinding,
} from "./types";
import log from "./logger";

export async function loadImportSource(
  vdomImportSource: ReactPyVdomImportSource,
  client: ReactPyClientInterface,
): Promise<BindImportSource> {
  let module: ReactPyModule;
  if (vdomImportSource.sourceType === "URL") {
    module = await import(vdomImportSource.source);
  } else {
    module = await client.loadModule(vdomImportSource.source);
  }
  if (typeof module.bind !== "function") {
    throw new Error(
      `${vdomImportSource.source} did not export a function 'bind'`,
    );
  }

  return (node: HTMLElement) => {
    const binding = module.bind(node, {
      sendMessage: client.sendMessage,
      onMessage: client.onMessage,
    });
    if (
      !(
        typeof binding.create === "function" &&
        typeof binding.render === "function" &&
        typeof binding.unmount === "function"
      )
    ) {
      log.error(`${vdomImportSource.source} returned an impropper binding`);
      return null;
    }

    return {
      render: (model) =>
        binding.render(
          createImportSourceElement({
            client,
            module,
            binding,
            model,
            currentImportSource: vdomImportSource,
          }),
        ),
      unmount: binding.unmount,
    };
  };
}

function createImportSourceElement(props: {
  client: ReactPyClientInterface;
  module: ReactPyModule;
  binding: ReactPyModuleBinding;
  model: ReactPyVdom;
  currentImportSource: ReactPyVdomImportSource;
}): any {
  let type: any;
  if (props.model.importSource) {
    if (
      !isImportSourceEqual(props.currentImportSource, props.model.importSource)
    ) {
      log.error(
        "Parent element import source " +
          stringifyImportSource(props.currentImportSource) +
          " does not match child's import source " +
          stringifyImportSource(props.model.importSource),
      );
      return null;
    } else {
      type = getComponentFromModule(
        props.module,
        props.model.tagName,
        props.model.importSource,
      );
      if (!type) {
        // Error message logged within getComponentFromModule
        return null;
      }
    }
  } else {
    type = props.model.tagName;
  }
  return props.binding.create(
    type,
    createAttributes(props.model, props.client),
    createChildren(props.model, (child) =>
      createImportSourceElement({
        ...props,
        model: child,
      }),
    ),
  );
}

function getComponentFromModule(
  module: ReactPyModule,
  componentName: string,
  importSource: ReactPyVdomImportSource,
): any {
  /*  Gets the component with the provided name from the provided module.

  Built specifically to work on inifinitely deep nested components.
  For example, component "My.Nested.Component" is accessed from
  ModuleA like so: ModuleA["My"]["Nested"]["Component"].
  */
  const componentParts: string[] = componentName.split(".");
  let Component: any = null;
  for (let i = 0; i < componentParts.length; i++) {
    const iterAttr = componentParts[i];
    Component = i == 0 ? module[iterAttr] : Component[iterAttr];
    if (!Component) {
      if (i == 0) {
        log.error(
          "Module from source " +
            stringifyImportSource(importSource) +
            ` does not export ${iterAttr}`,
        );
      } else {
        console.error(
          `Component ${componentParts.slice(0, i).join(".")} from source ` +
            stringifyImportSource(importSource) +
            ` does not have subcomponent ${iterAttr}`,
        );
      }
      break;
    }
  }
  return Component;
}

function isImportSourceEqual(
  source1: ReactPyVdomImportSource,
  source2: ReactPyVdomImportSource,
) {
  return (
    source1.source === source2.source &&
    source1.sourceType === source2.sourceType
  );
}

function stringifyImportSource(importSource: ReactPyVdomImportSource) {
  return JSON.stringify({
    source: importSource.source,
    sourceType: importSource.sourceType,
  });
}

export function createChildren<Child>(
  model: ReactPyVdom,
  createChild: (child: ReactPyVdom) => Child,
): (Child | string)[] {
  if (!model.children) {
    return [];
  } else {
    return model.children.map((child) => {
      switch (typeof child) {
        case "object":
          return createChild(child);
        case "string":
          return child;
      }
    });
  }
}

export function createAttributes(
  model: ReactPyVdom,
  client: ReactPyClientInterface,
): { [key: string]: any } {
  return Object.fromEntries(
    Object.entries({
      // Normal HTML attributes
      ...model.attributes,
      // Construct event handlers
      ...Object.fromEntries(
        Object.entries(model.eventHandlers || {}).map(([name, handler]) =>
          createEventHandler(client, name, handler),
        ),
      ),
      ...Object.fromEntries(
        Object.entries(model.inlineJavaScript || {}).map(
          ([name, inlineJavaScript]) =>
            createInlineJavaScript(name, inlineJavaScript),
        ),
      ),
    }),
  );
}

function createEventHandler(
  client: ReactPyClientInterface,
  name: string,
  { target, preventDefault, stopPropagation }: ReactPyVdomEventHandler,
): [string, () => void] {
  const eventHandler = function (...args: any[]) {
    const data = Array.from(args).map((value) => {
      const event = value as Event;
      if (preventDefault) {
        event.preventDefault();
      }
      if (stopPropagation) {
        event.stopPropagation();
      }
      return serializeEvent(event);
    });
    client.sendMessage({ type: "layout-event", data, target });
  };
  eventHandler.isHandler = true;
  return [name, eventHandler];
}

function createInlineJavaScript(
  name: string,
  inlineJavaScript: string,
): [string, () => void] {
  /* Function that will execute the string-like InlineJavaScript
  via eval in the most appropriate way */
  const wrappedExecutable = function (...args: any[]) {
    function handleExecution(...args: any[]) {
      const evalResult = eval(inlineJavaScript);
      if (typeof evalResult == "function") {
        return evalResult(...args);
      }
    }
    if (args.length > 0 && args[0] instanceof Event) {
      /* If being triggered by an event, set the event's current
      target to "this". This ensures that inline
      javascript statements such as the following work:
      html.button({"onclick": 'this.value = "Clicked!"'}, "Click Me")*/
      return handleExecution.call(args[0].currentTarget, ...args);
    } else {
      /* If not being triggered by an event, do not set "this" and
      just call normally */
      return handleExecution(...args);
    }
  };
  wrappedExecutable.isHandler = false;
  return [name, wrappedExecutable];
}
