import {
  useCallback,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  pointerWithin,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
  type CollisionDetection,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import { Text, View } from "react-native";
import { Folder } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  useSidebarFoldersStore,
  resolveSidebarRootKeys,
  insertSidebarRootKey,
  type SidebarFolder,
} from "@/stores/sidebar-folders-store";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { MenuSubTrigger, MenuItem, type MenuPageDefinition } from "@/components/ui/menu";
import { InlineRename } from "@/components/ui/inline-rename";
import { DensityIcon } from "@/components/ui/density-icon";
import { sidebarTypography } from "./typography";
import { ProjectLeadingVisual } from "./project-leading-visual";
import { sidebarSpacing } from "./spacing";
import { densityIconBox } from "@/styles/density";
import {
  TreeChevron,
  TREE_INDENT_PER_LEVEL,
  WORKSPACE_TREE_ICON_SIZE,
} from "@/components/tree-primitives";

export function ProjectFolders({
  projects,
  renderProject,
  onReorder,
  projectIconByProjectViewKey,
}: {
  projects: SidebarProjectEntry[];
  renderProject: (info: DraggableRenderItemInfo<SidebarProjectEntry>) => ReactElement;
  onReorder: (projects: SidebarProjectEntry[]) => void;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
}) {
  const folders = useSidebarFoldersStore((state) => state.folders);
  const rootOrder = useSidebarFoldersStore((state) => state.rootOrder);
  const setRootOrder = useSidebarFoldersStore((state) => state.setRootOrder);
  const rootKeys = useMemo(
    () =>
      resolveSidebarRootKeys({
        folders,
        projectKeys: projects.map((project) => project.viewKey),
        order: rootOrder,
      }),
    [folders, projects, rootOrder],
  );
  const move = useSidebarFoldersStore((state) => state.moveProject);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const start = useCallback((event: DragStartEvent) => setActiveKey(String(event.active.id)), []);
  const cancel = useCallback(() => setActiveKey(null), []);
  const end = useCallback(
    (event: DragEndEvent) => {
      setActiveKey(null);
      if (!event.over) return;
      const key = String(event.active.id);
      const target = String(event.over.id);
      const placement = parseFolderEdge(target);
      if (placement) {
        if (!key.startsWith("folder:")) move(key, null);
        setRootOrder(
          insertSidebarRootKey({
            keys: rootKeys,
            key,
            target: `folder:${placement.folderId}`,
            placement: placement.edge,
          }),
        );
        return;
      }
      if (key.startsWith("folder:")) {
        const containingFolder = folders.find((folder) => folder.projectKeys.includes(target));
        const rootTarget = containingFolder ? `folder:${containingFolder.id}` : target;
        const from = rootKeys.indexOf(key);
        const to =
          rootTarget === "folder-root" ? rootKeys.length - 1 : rootKeys.indexOf(rootTarget);
        if (from >= 0 && to >= 0 && from !== to) setRootOrder(arrayMove(rootKeys, from, to));
        return;
      }
      if (target === "folder-root") {
        move(key, null);
        return;
      }
      const folder = folders.find((entry) => `folder:${entry.id}` === target);
      if (folder) {
        move(key, folder.id);
        return;
      }
      const from = projects.findIndex((project) => project.viewKey === key);
      const to = projects.findIndex((project) => project.viewKey === target);
      if (from < 0 || to < 0 || from === to) return;
      const destination = folders.find((entry) => entry.projectKeys.includes(target));
      move(key, destination?.id ?? null);
      onReorder(arrayMove(projects, from, to));
      if (!destination) {
        const keys = rootKeys.includes(key) ? rootKeys : [...rootKeys, key];
        setRootOrder(arrayMove(keys, keys.indexOf(key), keys.indexOf(target)));
      }
    },
    [folders, projects, move, onReorder, rootKeys, setRootOrder],
  );
  const renderProjects = useCallback(
    (items: SidebarProjectEntry[]) => (
      <ProjectDragGroup projects={items} renderProject={renderProject} />
    ),
    [renderProject],
  );
  const active = projects.find((project) => project.viewKey === activeKey);
  const activeFolder = folders.find((folder) => `folder:${folder.id}` === activeKey);
  const rootSortingStrategy = useCallback(
    (args: Parameters<typeof verticalListSortingStrategy>[0]) => {
      if (args.overIndex < 0) return null;
      const source = rootKeys[args.activeIndex];
      const target = rootKeys[args.overIndex];
      if (source && !source.startsWith("folder:") && target?.startsWith("folder:")) return null;
      return verticalListSortingStrategy(args);
    },
    [rootKeys],
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={projectFolderCollision}
      onDragStart={start}
      onDragCancel={cancel}
      onDragEnd={end}
    >
      <SortableContext items={rootKeys} strategy={rootSortingStrategy}>
        <View testID="sidebar-project-root-list">
          {rootKeys.map((key) => {
            const folder = folders.find((entry) => `folder:${entry.id}` === key);
            if (folder)
              return (
                <ProjectFolder
                  key={key}
                  folder={folder}
                  projects={projects}
                  renderProjects={renderProjects}
                />
              );
            const project = projects.find((entry) => entry.viewKey === key);
            return project ? (
              <FolderDraggableProject
                key={key}
                project={project}
                index={rootKeys.indexOf(key)}
                renderProject={renderProject}
              />
            ) : null;
          })}
        </View>
      </SortableContext>
      <RootProjectDropTarget active={activeKey !== null} />
      {activeKey !== null &&
        createPortal(
          <style>{"html, body, body * { cursor: grabbing !important; }"}</style>,
          document.head,
        )}
      {createPortal(
        <DragOverlay modifiers={PROJECT_PREVIEW_MODIFIERS} dropAnimation={null}>
          <ProjectFolderDragPreview
            project={active}
            folder={activeFolder}
            icons={projectIconByProjectViewKey}
          />
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

function ProjectFolderDragPreview({
  project,
  folder,
  icons,
}: {
  project: SidebarProjectEntry | undefined;
  folder: SidebarFolder | undefined;
  icons: ReadonlyMap<string, string | null>;
}) {
  if (project)
    return (
      <View style={styles.row} testID="sidebar-project-drag-preview">
        <ProjectLeadingVisual
          displayName={project.projectName}
          projectViewKey={project.viewKey}
          iconDataUri={icons.get(project.viewKey) ?? null}
          statusBucket={null}
          backdrop="surfaceSidebar"
        />
        <Text style={styles.title}>{project.projectName}</Text>
      </View>
    );
  if (folder)
    return (
      <View style={styles.row} testID="sidebar-folder-drag-preview">
        <DensityIcon icon={Folder} size="md" color="foregroundMuted" />
        <Text style={styles.title}>{folder.name}</Text>
      </View>
    );
  return null;
}

const projectFolderCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const edge = hits.find((hit) => parseFolderEdge(String(hit.id)) !== null);
  if (edge) return [edge];
  const folder = hits.find((hit) => String(hit.id).startsWith("folder:"));
  if (folder) return [folder];
  if (args.pointerCoordinates && hits.length === 0) return [];
  const project = hits.find((hit) => hit.id !== "folder-root" && hit.id !== args.active.id);
  if (project) return [project];
  const root = hits.find((hit) => hit.id === "folder-root");
  if (root) return [root];
  return args.pointerCoordinates ? [] : closestCenter(args);
};
function parseFolderEdge(id: string): { folderId: string; edge: "before" | "after" } | null {
  if (id.startsWith("folder-before:"))
    return { folderId: id.slice("folder-before:".length), edge: "before" };
  if (id.startsWith("folder-after:"))
    return { folderId: id.slice("folder-after:".length), edge: "after" };
  return null;
}
function containedSortingStrategy(args: Parameters<typeof verticalListSortingStrategy>[0]) {
  return args.overIndex < 0 ? null : verticalListSortingStrategy(args);
}
const positionProjectPreview: Modifier = ({
  activatorEvent,
  activeNodeRect,
  overlayNodeRect,
  transform,
}) => {
  if (!(activatorEvent instanceof MouseEvent) || !activeNodeRect || !overlayNodeRect)
    return transform;
  return {
    ...transform,
    // Preserve the horizontal grab point; centering a sidebar-wide row shifts its label left.
    x: transform.x,
    y: transform.y + activatorEvent.clientY - activeNodeRect.top - overlayNodeRect.height / 2,
  };
};
const PROJECT_PREVIEW_MODIFIERS = [positionProjectPreview];
const beforeDropStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  height: "25%",
  pointerEvents: "none",
};
const afterDropStyle: CSSProperties = {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  height: "25%",
  pointerEvents: "none",
};
function ProjectDragGroup({
  projects,
  renderProject,
}: {
  projects: SidebarProjectEntry[];
  renderProject: (info: DraggableRenderItemInfo<SidebarProjectEntry>) => ReactElement;
}) {
  const ids = useMemo(() => projects.map((project) => project.viewKey), [projects]);
  return (
    <SortableContext items={ids} strategy={containedSortingStrategy}>
      <View testID="sidebar-project-list">
        {projects.map((project, index) => (
          <FolderDraggableProject
            key={project.viewKey}
            project={project}
            index={index}
            renderProject={renderProject}
          />
        ))}
      </View>
    </SortableContext>
  );
}
const noOpDrag = () => {};
function FolderDraggableProject({
  project,
  index,
  renderProject,
}: {
  project: SidebarProjectEntry;
  index: number;
  renderProject: (info: DraggableRenderItemInfo<SidebarProjectEntry>) => ReactElement;
}) {
  const drag = useSortable({ id: project.viewKey });
  const style = useMemo(
    () => ({
      transform: CSS.Transform.toString(drag.transform),
      transition: drag.transition,
      opacity: drag.isDragging ? 0.35 : 1,
    }),
    [drag.transform, drag.transition, drag.isDragging],
  );
  const { setActivatorNodeRef } = drag;
  const setActivator = useCallback(
    (node: unknown) => setActivatorNodeRef(node instanceof HTMLElement ? node : null),
    [setActivatorNodeRef],
  );
  const handle = useMemo(
    () => ({
      attributes: { ...drag.attributes },
      listeners: { ...drag.listeners },
      setActivatorNodeRef: setActivator,
    }),
    [drag.attributes, drag.listeners, setActivator],
  );
  return (
    <div ref={drag.setNodeRef} style={style}>
      {renderProject({
        item: project,
        index,
        drag: noOpDrag,
        isActive: drag.isDragging,
        dragHandleProps: handle,
      })}
    </div>
  );
}
function RootProjectDropTarget({ active }: { active: boolean }) {
  const drop = useDroppable({ id: "folder-root", disabled: !active });
  const { setNodeRef } = drop;
  const setPanel = useCallback(
    (node: HTMLDivElement | null) => {
      const panel = node?.closest('[data-testid="sidebar-project-workspace-list-scroll"]');
      setNodeRef(panel instanceof HTMLElement ? panel : null);
    },
    [setNodeRef],
  );
  return (
    <div
      ref={setPanel}
      data-testid="sidebar-folder-root-drop"
      data-folder-root-drop-active={active && drop.isOver}
    />
  );
}

function ProjectFolder({
  folder,
  projects,
  renderProjects,
}: {
  folder: SidebarFolder;
  projects: SidebarProjectEntry[];
  renderProjects: (projects: SidebarProjectEntry[]) => ReactNode;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const enter = useCallback(() => setIsHovered(true), []);
  const leave = useCallback(() => setIsHovered(false), []);
  const editing = useSidebarFoldersStore((state) => state.editingId === folder.id);
  const edit = useSidebarFoldersStore((state) => state.editFolder);
  const toggle = useSidebarFoldersStore((state) => state.toggleFolder);
  const rename = useSidebarFoldersStore((state) => state.renameFolder);
  const remove = useSidebarFoldersStore((state) => state.removeFolder);
  const begin = useCallback(() => edit(folder.id), [edit, folder.id]);
  const close = useCallback(() => edit(null), [edit]);
  const save = useCallback(async (name: string) => rename(folder.id, name), [rename, folder.id]);
  const collapse = useCallback(() => {
    if (!editing) toggle(folder.id);
  }, [editing, toggle, folder.id]);
  const deleteFolder = useCallback(() => remove(folder.id), [remove, folder.id]);
  const children = projects.filter((project) => folder.projectKeys.includes(project.viewKey));
  const drop = useSortable({ id: `folder:${folder.id}`, disabled: editing });
  const { setDroppableNodeRef } = drop;
  const setDropRef = useCallback(
    (node: unknown) => setDroppableNodeRef(node instanceof HTMLElement ? node : null),
    [setDroppableNodeRef],
  );
  const dropData = useMemo(() => ({ folderDropActive: String(drop.isOver) }), [drop.isOver]);
  const rowStyle = useMemo(() => [styles.row, drop.isOver && styles.dropRow], [drop.isOver]);
  const { role: _folderRole, tabIndex: _folderTabIndex, ...folderAttributes } = drop.attributes;
  const dragStyle = useMemo(
    () => ({
      width: "100%",
      transform: CSS.Transform.toString(drop.transform),
      transition: drop.transition,
      opacity: drop.isDragging ? 0.35 : 1,
    }),
    [drop.transform, drop.transition, drop.isDragging],
  );
  const expanded = useMemo(() => ({ expanded: !folder.collapsed }), [folder.collapsed]);
  const doubleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      begin();
    },
    [begin],
  );
  return (
    <div
      ref={drop.setDraggableNodeRef}
      style={dragStyle}
      data-testid={`sidebar-folder-${folder.id}`}
    >
      <View
        ref={setDropRef}
        style={styles.folderDrop}
        dataSet={dropData}
        onPointerEnter={enter}
        onPointerLeave={leave}
      >
        <ContextMenu>
          <ContextMenuTrigger
            {...folderAttributes}
            {...drop.listeners}
            accessibilityRole="button"
            accessibilityLabel={folder.name}
            accessibilityState={expanded}
            aria-expanded={!folder.collapsed}
            onPress={collapse}
            style={rowStyle}
            testID={`sidebar-folder-row-${folder.id}`}
          >
            {isHovered && !drop.isOver ? (
              <View
                pointerEvents="none"
                style={styles.rowHoverBackground}
                testID="sidebar-folder-hover-background"
              />
            ) : null}
            <View style={styles.chevronSlot}>
              {children.length > 0 ? (
                <View testID={`sidebar-folder-disclosure-${folder.id}`}>
                  <TreeChevron expanded={!folder.collapsed} />
                </View>
              ) : null}
            </View>
            <View style={styles.leadingIcon} testID={`sidebar-folder-icon-${folder.id}`}>
              <DensityIcon icon={Folder} size="md" color="foregroundMuted" />
            </View>
            <Text style={styles.title} numberOfLines={1}>
              {editing ? (
                <InlineRename
                  initialValue={folder.name}
                  label="Rename folder"
                  testID={`sidebar-folder-name-${folder.id}`}
                  onSubmit={save}
                  onClose={close}
                  maxLength={200}
                />
              ) : (
                <span onDoubleClick={doubleClick}>{folder.name}</span>
              )}
            </Text>
          </ContextMenuTrigger>
          <ContextMenuContent width={220}>
            <ContextMenuItem onSelect={begin}>Rename folder</ContextMenuItem>
            <ContextMenuItem onSelect={deleteFolder}>Remove folder</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <FolderEdgeDropTarget folderId={folder.id} edge="before" />
        <FolderEdgeDropTarget folderId={folder.id} edge="after" />
      </View>
      {!folder.collapsed && <View style={styles.children}>{renderProjects(children)}</View>}
    </div>
  );
}

function FolderEdgeDropTarget({ folderId, edge }: { folderId: string; edge: "before" | "after" }) {
  const drop = useDroppable({ id: `folder-${edge}:${folderId}` });
  return (
    <div
      ref={drop.setNodeRef}
      style={edge === "before" ? beforeDropStyle : afterDropStyle}
      data-folder-drop-placement={edge}
      data-folder-drop-active={drop.isOver}
    >
      {drop.isOver && <View style={edge === "before" ? styles.insertBefore : styles.insertAfter} />}
    </div>
  );
}

export function ProjectFolderMenuTrigger() {
  const hasFolders = useSidebarFoldersStore((state) => state.folders.length > 0);
  return hasFolders ? <MenuSubTrigger id="project-folders">Move to folder</MenuSubTrigger> : null;
}
export function useProjectFolderMenuPages(projectKey: string): MenuPageDefinition[] {
  const folders = useSidebarFoldersStore((state) => state.folders);
  return useMemo(
    () => [
      {
        id: "project-folders",
        title: "Move to folder",
        content: (
          <>
            <ProjectFolderChoice
              projectKey={projectKey}
              folderId={null}
              name="No folder"
              selected={!folders.some((folder) => folder.projectKeys.includes(projectKey))}
            />
            {folders.map((folder) => (
              <ProjectFolderChoice
                key={folder.id}
                projectKey={projectKey}
                folderId={folder.id}
                name={folder.name}
                selected={folder.projectKeys.includes(projectKey)}
              />
            ))}
          </>
        ),
      },
    ],
    [folders, projectKey],
  );
}
function ProjectFolderChoice({
  projectKey,
  folderId,
  name,
  selected,
}: {
  projectKey: string;
  folderId: string | null;
  name: string;
  selected: boolean;
}) {
  const move = useSidebarFoldersStore((state) => state.moveProject);
  const select = useCallback(() => move(projectKey, folderId), [move, projectKey, folderId]);
  return (
    <MenuItem selected={selected} onSelect={select}>
      {name}
    </MenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  folderDrop: { width: "100%", position: "relative" },
  rowHoverBackground: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -theme.spacing[0.5],
    right: 0,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  insertBefore: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: theme.colors.accent,
  },
  insertAfter: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: theme.colors.accent,
  },
  row: {
    borderRadius: theme.borderRadius.lg,
    width: "100%",
    alignSelf: "stretch",
    ...sidebarSpacing(theme).treeHeader,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  leadingIcon: {
    width: { xs: densityIconBox("md").xs + 2, md: densityIconBox("md").md + 2 },
    height: densityIconBox("md"),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chevronSlot: {
    position: "absolute",
    left: sidebarSpacing(theme).treeInset,
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    alignItems: "flex-start",
  },
  title: { ...sidebarTypography(theme).primary, color: theme.colors.foregroundMuted, flex: 1 },
  children: {
    // Keep child icons one small gap left of the folder label, without duplicating row padding.
    paddingLeft: TREE_INDENT_PER_LEVEL,
  },
  dropRow: {
    width: "100%",
    alignSelf: "stretch",
    ...sidebarSpacing(theme).treeHeader,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
}));
