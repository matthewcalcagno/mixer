import {
  createRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { getDesktopHost } from "@/desktop/host";
import { useToast } from "@/contexts/toast-context";
import { useMenuContext } from "./menu-context";
import { MenuPage } from "./menu-item";
import {
  NativeMenuRegistry,
  NativePageProvider,
  NativeRegistryProvider,
  nativeMenuHasControls,
  type NativePage,
} from "./native-menu";
import type { MenuSurfaceProps } from "./menu-surface";

const RESOURCE_WAIT_MS = 1000;

function isFormPage(page: NonNullable<MenuSurfaceProps["pages"]>[number]): boolean {
  return page.fill === true || page.hoverIntent === false;
}

/** Render definitions invisibly, then hand a frozen action tree to Electron. */
export function NativeMenuSurface(props: MenuSurfaceProps): ReactElement | null {
  const menu = useMenuContext("NativeMenuSurface");
  const toast = useToast();
  const [registry] = useState(() => new NativeMenuRegistry());
  const root = useRef<HTMLDivElement>(null);
  const pageNodes = useRef(new Map<string, ReturnType<typeof createRef<HTMLDivElement>>>());
  const formProps = useRef<MenuSurfaceProps | null>(null);
  const epoch = useRef(0);
  const latest = useRef({ props, menu, toast });
  latest.current = { props, menu, toast };
  const { open, presentation, nativeFormDepth, path, setOpen } = menu;
  const pages = props.pages ?? [];
  for (const page of pages) {
    if (!pageNodes.current.has(page.id))
      pageNodes.current.set(page.id, createRef<HTMLDivElement>());
  }

  useEffect(() => {
    if (!open) formProps.current = null;
  }, [open]);
  useEffect(() => {
    if (presentation === "dialog" && nativeFormDepth !== null && path.length < nativeFormDepth)
      setOpen(false);
  }, [nativeFormDepth, path.length, presentation, setOpen]);

  useEffect(() => {
    if (!open || presentation !== "native") return;
    const generation = ++epoch.current;
    let disposed = false;
    let frame = 0;
    let frames = 0;
    const started = performance.now();
    const show = async () => {
      const current = latest.current;
      let dispatched = false;
      let form = false;
      try {
        if (disposed) return;
        if (nativeMenuHasControls(root.current)) {
          form = true;
          formProps.current = current.props;
          current.menu.openNativeForm([]);
          return;
        }
        const definitions: NativePage[] = (current.props.pages ?? []).map((page) => ({
          id: page.id,
          title: page.fill === true ? undefined : page.title,
          form: isFormPage(page),
          node: pageNodes.current.get(page.id),
        }));
        const snapshot = registry.snapshot(definitions, root);
        if (snapshot.items.length === 0) return;
        const popup = getDesktopHost()?.menu?.showContextMenu;
        if (!popup) throw new Error("Relaunch the desktop app to enable native menus.");
        const selected = await popup({ kind: "actions", items: snapshot.items });
        if (disposed || typeof selected !== "string") return;
        const selectedForm = snapshot.forms.get(selected);
        if (selectedForm) {
          form = true;
          formProps.current = current.props;
          current.menu.openNativeForm(selectedForm.path);
          return;
        }
        current.menu.setOpen(false);
        dispatched = true;
        await snapshot.actions.get(selected)?.();
      } catch (error) {
        if (!disposed || dispatched)
          current.toast.error(
            error instanceof Error ? error.message : "Unable to open native menu",
          );
      } finally {
        if (!form && !disposed && epoch.current === generation) current.menu.setOpen(false);
      }
    };
    const settle = () => {
      if (disposed) return;
      frames++;
      if (frames < 2 || (registry.pending() && performance.now() - started < RESOURCE_WAIT_MS)) {
        frame = requestAnimationFrame(settle);
        return;
      }
      void show();
    };
    frame = requestAnimationFrame(settle);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
    };
  }, [open, presentation, registry]);

  if (!open) return null;
  if (presentation === "dialog") return <NativeMenuDialog surface={formProps.current ?? props} />;
  return (
    <NativeRegistryProvider value={registry}>
      <div hidden inert aria-hidden="true" data-testid="native-menu-definitions">
        <NativePageProvider value={null}>
          <div ref={root}>
            <MenuPage depth={0}>{props.children}</MenuPage>
          </div>
        </NativePageProvider>
        {pages
          .filter((page) => !isFormPage(page))
          .map((page) => (
            <NativePageProvider key={page.id} value={page.id}>
              <div ref={pageNodes.current.get(page.id)}>
                <MenuPage depth={1}>{page.content}</MenuPage>
              </div>
            </NativePageProvider>
          ))}
      </div>
    </NativeRegistryProvider>
  );
}

function NativeMenuDialog({ surface }: { surface: MenuSurfaceProps }): ReactElement | null {
  const { path, nativeFormDepth, setOpen, goBack } = useMenuContext("NativeMenuDialog");
  const activeId = path[path.length - 1];
  const activePage = surface.pages?.find((page) => page.id === activeId);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const header = useMemo<SheetHeader>(
    () => ({
      title:
        activePage?.fill === true ? "" : (activePage?.title ?? surface.sheetTitle ?? "Options"),
      back:
        nativeFormDepth !== null && path.length > nativeFormDepth
          ? {
              onPress: () => {
                goBack();
              },
            }
          : undefined,
      actions: surface.sheetTrailing,
    }),
    [activePage, surface.sheetTitle, surface.sheetTrailing, goBack, nativeFormDepth, path.length],
  );
  if ((activeId && !activePage) || (nativeFormDepth !== null && path.length < nativeFormDepth))
    return null;
  return (
    <NativeRegistryProvider value={null}>
      <AdaptiveModalSheet
        visible
        onClose={close}
        header={header}
        desktopMaxWidth={Math.max(420, surface.width ?? surface.maxWidth ?? 420)}
        desktopHeight={activePage?.fill === true ? "85%" : undefined}
        scrollable={activePage?.fill !== true}
        testID={surface.testID ? `${surface.testID}-dialog` : "native-menu-dialog"}
      >
        <MenuPage depth={path.length}>{activePage?.content ?? surface.children}</MenuPage>
      </AdaptiveModalSheet>
    </NativeRegistryProvider>
  );
}
