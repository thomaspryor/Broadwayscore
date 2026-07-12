'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useUserLists } from '@/hooks/useUserLists';
import { useToastSafe } from '@/components/ui/Toast';
import type { UserList, ListItem, ShowLookup } from '@/types/user';
import {
  DndContext, closestCenter, DragOverlay,
  PointerSensor, TouchSensor, KeyboardSensor,
  useSensor, useSensors,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Modal, ShowSearchDropdown } from '@/components/show-cards';
import { useClickOutside } from '@/hooks/useClickOutside';

interface ShowMap {
  [showId: string]: ShowLookup;
}

interface SearchShow {
  id: string;
  title: string;
  slug: string;
  status: string;
  venue?: string;
  od?: string;
  images?: { thumbnail?: string };
  category?: string;
}

interface ListsTabProps {
  userId: string | null;
  showMap: ShowMap;
  isMockMode: boolean;
  /** Increment to trigger the create-list modal from the parent header button */
  createTrigger?: number;
}

export default function ListsTab({ userId, showMap, isMockMode, createTrigger = 0 }: ListsTabProps) {
  const searchParams = useSearchParams();
  const activeListId = searchParams.get('list');
  const { showToast } = useToastSafe();

  const {
    lists: realLists, loading: realLoading, getLists, getListItems,
    createList, updateList, deleteList,
    addToList, removeFromList, reorderList,
    shareList, togglePublic,
  } = useUserLists(userId);

  const [mockData, setMockData] = useState<{ lists: UserList[]; items: Record<string, ListItem[]> } | null>(null);
  const [listItems, setListItems] = useState<ListItem[]>([]);
  const [listItemsLoading, setListItemsLoading] = useState(false);
  const [showModal, setShowModal] = useState<'create' | 'edit' | null>(null);
  const [editingList, setEditingList] = useState<UserList | null>(null);

  // Mock mode: load mock data
  useEffect(() => {
    if (!isMockMode) return;
    import('./__dev-mock-data').then(mod => {
      setMockData({ lists: mod.mockLists, items: mod.mockListItems });
    });
  }, [isMockMode]);

  // Open create modal when parent header button triggers it
  useEffect(() => {
    if (createTrigger > 0) setShowModal('create');
  }, [createTrigger]);

  const lists = isMockMode && mockData ? mockData.lists : realLists;
  const loading = isMockMode ? !mockData : realLoading;

  // Load lists on mount
  useEffect(() => {
    if (userId && !isMockMode) {
      getLists();
    }
  }, [userId, isMockMode, getLists]);

  // Load items when viewing a specific list
  useEffect(() => {
    if (!activeListId) return;
    if (isMockMode && mockData) {
      setListItems(mockData.items[activeListId] || []);
      return;
    }
    if (!userId || isMockMode) return;
    setListItemsLoading(true);
    getListItems(activeListId).then(items => {
      setListItems(items);
      setListItemsLoading(false);
    });
  }, [activeListId, userId, isMockMode, mockData, getListItems]);

  const activeList = lists.find(l => l.id === activeListId);

  const navigateToList = (listId: string | null) => {
    const base = '/my-shows?tab=lists';
    const url = listId ? `${base}&list=${listId}` : base;
    window.history.pushState(null, '', url);
    // Trigger re-render via popstate won't work, so use replaceState + force
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const handleCreateList = async (name: string, description: string | null, isRanked: boolean) => {
    try {
      const newList = await createList(name, description, isRanked);
      if (newList) {
        setShowModal(null);
        navigateToList(newList.id);
      } else {
        showToast?.('Failed to create list.', 'error');
      }
    } catch {
      showToast?.('Failed to create list.', 'error');
    }
  };

  const handleUpdateList = async (listId: string, name: string, description: string | null, isRanked: boolean, isPublic?: boolean) => {
    try {
      await updateList(listId, { name, description, is_ranked: isRanked, ...(isPublic !== undefined && { is_public: isPublic }) });
      setShowModal(null);
      setEditingList(null);
    } catch {
      showToast?.('Failed to update list.', 'error');
    }
  };

  const handleDeleteList = async (listId: string) => {
    const name = lists.find(l => l.id === listId)?.name || 'List';
    try {
      await deleteList(listId);
      navigateToList(null);
      showToast?.(`"${name}" deleted.`, 'info');
    } catch {
      showToast?.('Failed to delete list.', 'error');
    }
  };

  const handleAddToList = async (listId: string, showId: string) => {
    try {
      await addToList(listId, showId);
      const items = await getListItems(listId);
      setListItems(items);
      const showTitle = showMap[showId]?.title || 'Show';
      showToast?.(`Added "${showTitle}" to list.`, 'success');
    } catch {
      showToast?.('Failed to add show.', 'error');
    }
  };

  const handleRemoveFromList = async (listId: string, showId: string) => {
    try {
      await removeFromList(listId, showId);
      setListItems(prev => prev.filter(i => i.show_id !== showId));
      const showTitle = showMap[showId]?.title || 'Show';
      showToast?.(`Removed "${showTitle}" from list.`, 'info');
    } catch {
      showToast?.('Failed to remove show.', 'error');
    }
  };

  // Detail view
  if (activeListId && activeList) {
    return (
      <div>
        <ListDetailView
          list={activeList}
          items={listItems}
          loading={listItemsLoading}
          showMap={showMap}
          onBack={() => navigateToList(null)}
          onEdit={() => { setEditingList(activeList); setShowModal('edit'); }}
          onDelete={() => handleDeleteList(activeListId)}
          onAddShow={(showId) => handleAddToList(activeListId, showId)}
          onRemoveShow={(showId) => handleRemoveFromList(activeListId, showId)}
          onShare={async () => {
            const url = await shareList(activeListId);
            if (url) {
              try {
                await navigator.clipboard.writeText(url);
                showToast?.('Link copied!', 'success');
              } catch {
                showToast?.(url, 'info');
              }
            } else {
              showToast?.('Failed to share list.', 'error');
            }
          }}
          onMakePrivate={async () => {
            try {
              await togglePublic(activeListId, false);
              showToast?.('List is now private.', 'info');
            } catch {
              showToast?.('Failed to make list private.', 'error');
            }
          }}
          onReorder={(itemIds, positions) => {
            // Save previous state for undo
            const previousItems = [...listItems];
            // Optimistic: reorder local state immediately
            const idOrder = new Map(itemIds.map((id, i) => [id, i]));
            setListItems(prev => {
              const sorted = [...prev].sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));
              return sorted.map((item, i) => ({ ...item, position: positions[i] }));
            });
            // Persist in background
            reorderList(activeListId, itemIds, positions).catch(() => {
              setListItems(previousItems);
              showToast?.('Reorder failed — reverted.', 'error');
            });
          }}
        />
        {showModal === 'edit' && editingList && (
          <ListModal
            mode="edit"
            list={editingList}
            onSave={(name, desc, ranked, isPublic) => handleUpdateList(editingList.id, name, desc, ranked, isPublic)}
            onClose={() => { setShowModal(null); setEditingList(null); }}
            onDelete={() => handleDeleteList(editingList.id)}
          />
        )}
      </div>
    );
  }

  // Index view
  return (
    <div>
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-20 bg-white/5 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : lists.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3">📋</div>
          <h3 className="text-lg font-bold text-white mb-1">No lists yet</h3>
          <p className="text-sm text-gray-400 mb-4">Create lists to organize your shows.</p>
          <button
            type="button"
            onClick={() => setShowModal('create')}
            className="btn-primary text-sm"
          >
            Create a List
          </button>
        </div>
      ) : (
        <div className="space-y-1">
          {lists.map(list => (
            <ListRow
              key={list.id}
              list={list}
              showMap={showMap}
              onClick={() => navigateToList(list.id)}
            />
          ))}
        </div>
      )}

      {/* Create button (floating, when lists exist) */}
      {lists.length > 0 && (
        <button
          type="button"
          onClick={() => setShowModal('create')}
          className="btn-primary gap-2 w-full mt-6 text-sm"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          <span className="text-xs font-medium">Create a list</span>
        </button>
      )}

      {showModal === 'create' && (
        <ListModal
          mode="create"
          onSave={handleCreateList}
          onClose={() => setShowModal(null)}
        />
      )}
    </div>
  );
}

// --- List Index Row ---

function ListRow({ list, showMap, onClick }: { list: UserList; showMap: ShowMap; onClick: () => void }) {
  const previewShows = (list.preview_show_ids || []).map(id => showMap[id]).filter(Boolean);

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 sm:px-5 py-3 sm:py-4 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors text-left"
    >
      <div className="flex-1 min-w-0">
        <h4 className="font-bold text-white text-base truncate">{list.name}</h4>
        {list.description && (
          <p className="text-xs text-gray-600 truncate mt-0.5">{list.description}</p>
        )}
        <p className="text-xs text-gray-500 mt-0.5">
          {list.item_count || 0} {(list.item_count || 0) === 1 ? 'Show' : 'Shows'}
          {list.is_ranked && <span className="ml-1.5 text-xs font-semibold text-amber-400/70 bg-amber-400/10 px-1.5 py-0.5 rounded">Ranked</span>}
        </p>
      </div>
      {/* Poster previews */}
      <div className="flex-shrink-0 flex items-center gap-1">
        {previewShows.slice(0, 4).map((show, i) => (
          <div key={i} className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
            {show.posterUrl ? (
              <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm">🎭</div>
            )}
          </div>
        ))}
      </div>
      <svg className="w-4 h-4 text-gray-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}

// --- List Detail View ---

function ListDetailView({
  list, items, loading, showMap, onBack, onEdit, onDelete,
  onAddShow, onRemoveShow, onReorder, onShare, onMakePrivate,
}: {
  list: UserList;
  items: ListItem[];
  loading: boolean;
  showMap: ShowMap;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddShow: (showId: string) => void;
  onRemoveShow: (showId: string) => void;
  onReorder: (itemIds: string[], positions: number[]) => void;
  onShare: () => void;
  onMakePrivate: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [showAddSearch, setShowAddSearch] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    };
  }, []);

  // DnD sensors — pointer needs 5px distance, touch needs 200ms delay to avoid scroll conflicts
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 5 } });
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } });
  const keyboardSensor = useSensor(KeyboardSensor);
  const sensors = useSensors(pointerSensor, touchSensor, keyboardSensor);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = items.findIndex(i => i.id === active.id);
    const newIndex = items.findIndex(i => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // Build reordered array
    const reordered = [...items];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);

    // Assign fresh positions (index * 1000) and call onReorder
    const itemIds = reordered.map(i => i.id);
    const positions = reordered.map((_, idx) => (idx + 1) * 1000);
    onReorder(itemIds, positions);
  }, [items, onReorder]);

  const activeItem = activeId ? items.find(i => i.id === activeId) : null;

  const closeOverflow = useCallback(() => setShowOverflow(false), []);
  useClickOutside(overflowRef, closeOverflow, showOverflow);

  return (
    <div>
      {/* Back link */}
      <div className="mb-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-brand hover:text-brand/80 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Lists
        </button>
      </div>

      {/* List name + share + options menu */}
      <div className="flex items-center gap-1 mb-1">
        <h2 className="text-2xl font-extrabold text-white">{list.name}</h2>
        {/* Share button (hidden for empty lists) */}
        {items.length > 0 && (
        <button
          type="button"
          onClick={onShare}
          className="p-2.5 text-gray-400 hover:text-brand transition-colors"
          aria-label="Share list"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
          </svg>
        </button>
        )}
        <div className="relative" ref={overflowRef}>
          <button
            type="button"
            onClick={() => setShowOverflow(!showOverflow)}
            className="p-2 text-gray-400 hover:text-white transition-colors"
            aria-label="List options"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
          {showOverflow && (
            <div className="absolute left-0 top-full mt-1 bg-surface-raised border border-white/10 rounded-lg shadow-xl overflow-hidden z-50 min-w-[160px]">
              <button
                type="button"
                onClick={() => { setShowOverflow(false); onEdit(); }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-white hover:bg-white/5 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
                Edit List
              </button>
              {list.is_public && (
                <button
                  type="button"
                  onClick={() => { setShowOverflow(false); onMakePrivate(); }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-white hover:bg-white/5 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  Make Private
                </button>
              )}
              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDelete(true);
                    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
                    deleteTimerRef.current = setTimeout(() => setConfirmDelete(false), 4000);
                  }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-white/5 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete List
                </button>
              ) : (
                <div className="flex items-center gap-2 px-4 py-2.5 text-sm">
                  <button type="button" onClick={() => { setShowOverflow(false); onDelete(); }} className="text-red-400 hover:text-red-300 font-medium">Delete?</button>
                  <button type="button" onClick={() => setConfirmDelete(false)} className="text-gray-500 hover:text-white">No</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-500 mb-1">
        {items.length} {items.length === 1 ? 'Show' : 'Shows'}
        {list.is_ranked && <span className="ml-1.5 text-xs font-semibold text-amber-400/70 bg-amber-400/10 px-1.5 py-0.5 rounded">Ranked</span>}
        {list.is_public && <span className="ml-1.5 text-xs font-semibold text-green-400/70 bg-green-400/10 px-1.5 py-0.5 rounded">Public</span>}
      </p>
      {list.description && (
        <p className="text-sm text-gray-400 mb-4">{list.description}</p>
      )}

      {/* Items */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-16 bg-white/5 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">🎭</div>
          <h3 className="text-lg font-bold text-white mb-1">No shows yet</h3>
          <p className="text-sm text-gray-400 mb-4">Add shows to start building this list.</p>
          <button
            type="button"
            onClick={() => setShowAddSearch(true)}
            className="btn-primary text-sm"
          >
            Add a Show
          </button>
        </div>
      ) : list.is_ranked ? (
        /* Ranked list — drag-to-reorder enabled */
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <SortableContext items={items.map(i => i.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1">
              {items.map((item, index) => (
                <SortableListItem
                  key={item.id}
                  item={item}
                  index={index}
                  show={showMap[item.show_id]}
                  isRanked
                  confirmRemoveId={confirmRemoveId}
                  onRemove={(showId) => onRemoveShow(showId)}
                  onConfirmRemove={(id) => {
                    setConfirmRemoveId(id);
                    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
                    confirmTimerRef.current = setTimeout(() => setConfirmRemoveId(null), 4000);
                  }}
                  onCancelRemove={() => setConfirmRemoveId(null)}
                />
              ))}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {activeItem ? (
              <ListItemContent
                item={activeItem}
                index={items.indexOf(activeItem)}
                show={showMap[activeItem.show_id]}
                isRanked
                isDragOverlay
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        /* Unranked list — static */
        <div className="space-y-1">
          {items.map((item, index) => (
            <ListItemContent
              key={item.id}
              item={item}
              index={index}
              show={showMap[item.show_id]}
              isRanked={false}
              confirmRemoveId={confirmRemoveId}
              onRemove={(showId) => onRemoveShow(showId)}
              onConfirmRemove={(id) => {
                setConfirmRemoveId(id);
                if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
                confirmTimerRef.current = setTimeout(() => setConfirmRemoveId(null), 4000);
              }}
              onCancelRemove={() => setConfirmRemoveId(null)}
            />
          ))}
        </div>
      )}

      {/* Add a show */}
      {showAddSearch ? (
        <div className="mt-4">
          <ListAddShowSearch
            onSelect={(showId) => { onAddShow(showId); setShowAddSearch(false); }}
            onClose={() => setShowAddSearch(false)}
            existingShowIds={new Set(items.map(i => i.show_id))}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowAddSearch(true)}
          className="mt-4 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-gray-400 hover:text-white bg-white/[0.06] hover:bg-white/10 border border-white/10 transition-colors text-xs font-medium"
          aria-label="Add a show to this list"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          <span>Add show</span>
        </button>
      )}
    </div>
  );
}

// --- Sortable List Item (drag-to-reorder wrapper) ---

function SortableListItem({
  item, index, show, isRanked, confirmRemoveId,
  onRemove, onConfirmRemove, onCancelRemove,
}: {
  item: ListItem;
  index: number;
  show: ShowLookup | undefined;
  isRanked: boolean;
  confirmRemoveId: string | null;
  onRemove: (showId: string) => void;
  onConfirmRemove: (itemId: string) => void;
  onCancelRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <ListItemContent
        item={item}
        index={index}
        show={show}
        isRanked={isRanked}
        confirmRemoveId={confirmRemoveId}
        onRemove={onRemove}
        onConfirmRemove={onConfirmRemove}
        onCancelRemove={onCancelRemove}
        dragHandleRef={setActivatorNodeRef}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

// --- List Item Content (shared between sortable and static rendering) ---

function ListItemContent({
  item, index, show, isRanked, isDragOverlay,
  confirmRemoveId, onRemove, onConfirmRemove, onCancelRemove,
  dragHandleRef, dragHandleProps,
}: {
  item: ListItem;
  index: number;
  show: ShowLookup | undefined;
  isRanked: boolean;
  isDragOverlay?: boolean;
  confirmRemoveId?: string | null;
  onRemove?: (showId: string) => void;
  onConfirmRemove?: (itemId: string) => void;
  onCancelRemove?: () => void;
  dragHandleRef?: (node: HTMLElement | null) => void;
  dragHandleProps?: Record<string, unknown>;
}) {
  const title = show?.title || item.show_id;
  const slug = show?.slug || item.show_id;
  const href = `/show/${slug}`;

  return (
    <div
      className={`group/item relative flex items-center gap-3 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl border transition-colors ${
        isDragOverlay
          ? 'bg-surface-raised border-white/20 shadow-2xl scale-[1.02]'
          : 'bg-white/[0.02] border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04]'
      }`}
    >
      {!isDragOverlay && <Link href={href} className="absolute inset-0 z-0" aria-label={`View ${title}`} />}

      {/* Drag handle (ranked lists only) */}
      {isRanked && (
        <button
          type="button"
          ref={dragHandleRef}
          {...(dragHandleProps as React.ButtonHTMLAttributes<HTMLButtonElement>)}
          className="relative z-[1] flex-shrink-0 touch-none cursor-grab active:cursor-grabbing p-1 -ml-1 text-gray-600 hover:text-gray-400 transition-colors"
          aria-label="Drag to reorder"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="1.5" />
            <circle cx="15" cy="6" r="1.5" />
            <circle cx="9" cy="12" r="1.5" />
            <circle cx="15" cy="12" r="1.5" />
            <circle cx="9" cy="18" r="1.5" />
            <circle cx="15" cy="18" r="1.5" />
          </svg>
        </button>
      )}

      {/* Rank number */}
      {isRanked && (
        <span className="relative z-[1] flex-shrink-0 w-6 text-center text-sm font-bold text-gray-500 pointer-events-none">
          {index + 1}
        </span>
      )}

      {/* Poster */}
      <div className="relative z-[1] flex-shrink-0 w-12 sm:w-14 aspect-square rounded-lg overflow-hidden bg-surface-overlay pointer-events-none">
        {show?.posterUrl ? (
          <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-lg">🎭</div>
        )}
      </div>

      {/* Info */}
      <div className="relative z-[1] flex-1 min-w-0 pointer-events-none">
        <h4 className="font-bold text-white text-base group-hover/item:text-brand transition-colors truncate">{title}</h4>
        {show?.venue && <p className="text-sm text-gray-500 truncate">{show.venue}</p>}
      </div>

      {/* Remove button — 2-step confirm with 4s auto-reset */}
      {!isDragOverlay && onRemove && onConfirmRemove && onCancelRemove && (
        confirmRemoveId === item.id ? (
          <div className="relative z-[1] flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(item.show_id); onCancelRemove(); }}
              className="text-xs font-medium text-red-400 hover:text-red-300 px-2 py-1.5 min-h-[36px] flex items-center"
            >Remove?</button>
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCancelRemove(); }}
              className="text-xs text-gray-500 hover:text-white px-2 py-1.5 min-h-[36px] flex items-center"
            >No</button>
          </div>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault(); e.stopPropagation();
              onConfirmRemove(item.id);
            }}
            className="relative z-[1] text-xs text-gray-600 hover:text-red-400 transition-colors"
            aria-label={`Remove ${title} from list`}
          >Remove</button>
        )
      )}

      {/* Chevron */}
      {!isDragOverlay && (
        <svg className="relative z-[1] w-4 h-4 text-gray-600 flex-shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      )}
    </div>
  );
}

// --- Add Show Search (simplified for lists) ---

function ListAddShowSearch({
  onSelect, onClose, existingShowIds,
}: {
  onSelect: (showId: string) => void;
  onClose: () => void;
  existingShowIds: Set<string>;
}) {
  return (
    <ShowSearchDropdown
      onSelect={(show) => onSelect(show.id)}
      onClose={onClose}
      isDisabled={(show) => existingShowIds.has(show.id)}
      renderAction={(show) =>
        existingShowIds.has(show.id)
          ? <span className="text-green-400">Added</span>
          : <span>+ Add</span>
      }
    />
  );
}

// --- Create/Edit List Modal ---

function ListModal({
  mode, list, onSave, onClose, onDelete,
}: {
  mode: 'create' | 'edit';
  list?: UserList;
  onSave: (name: string, description: string | null, isRanked: boolean, isPublic?: boolean) => void;
  onClose: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(list?.name || '');
  const [description, setDescription] = useState(list?.description || '');
  const [isRanked, setIsRanked] = useState(list?.is_ranked || false);
  const [isPublic, setIsPublic] = useState(list?.is_public || false);
  const [showDescription, setShowDescription] = useState(!!list?.description);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  const canSave = name.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(name.trim(), description.trim() || null, isRanked, mode === 'edit' ? isPublic : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={true} onClose={onClose} maxWidth="md" bottomSheet ariaLabel={mode === 'create' ? 'Create list' : 'Edit list'}>
      {/* Header */}
        <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b border-white/10 bg-surface-raised z-10">
          <button type="button" onClick={onClose} className="text-sm text-brand hover:text-brand/80">
            Cancel
          </button>
          <h3 className="text-sm font-bold text-white">
            {mode === 'create' ? 'Create List' : 'Edit List'}
          </h3>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className={`text-sm font-bold ${canSave ? 'text-brand hover:text-brand/80' : 'text-gray-600'}`}
          >
            {saving ? '...' : 'Save'}
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">
              List Name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Best of 2025, Must-See..."
              maxLength={100}
              className="w-full px-3 py-2.5 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50"
              autoFocus
            />
          </div>

          {/* Description */}
          {showDescription ? (
            <div>
              <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">
                Description
              </label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What's this list about?"
                maxLength={500}
                rows={3}
                className="w-full px-3 py-2.5 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50 resize-none"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowDescription(true)}
              className="text-xs text-brand hover:text-brand/80 transition-colors"
            >
              + Add description
            </button>
          )}

          {/* Ranked toggle */}
          <div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-white">Ranked list</span>
              <button
                type="button"
                onClick={() => setIsRanked(!isRanked)}
                className={`relative w-11 h-6 rounded-full transition-colors ${isRanked ? 'bg-brand' : 'bg-white/20'}`}
                role="switch"
                aria-checked={isRanked}
              >
                <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${isRanked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
              </button>
            </div>
            <p className="text-xs text-gray-500 -mt-1">Numbers your shows 1, 2, 3…</p>
          </div>

          {/* Public toggle (edit mode only) */}
          {mode === 'edit' && (
            <div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm text-white">Public list</span>
                <button
                  type="button"
                  onClick={() => setIsPublic(!isPublic)}
                  className={`relative w-11 h-6 rounded-full transition-colors ${isPublic ? 'bg-green-500' : 'bg-white/20'}`}
                  role="switch"
                  aria-checked={isPublic}
                >
                  <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${isPublic ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <p className="text-xs text-gray-500 -mt-1">Anyone with the link can view this list</p>
              {isPublic && list?.share_slug && (
                <p className="text-xs text-brand mt-1 truncate">
                  {typeof window !== 'undefined' ? `${window.location.origin}/list/${list.share_slug}` : `/list/${list.share_slug}`}
                </p>
              )}
            </div>
          )}

          {/* Delete */}
          {mode === 'edit' && onDelete && (
            <div className="pt-4 border-t border-white/10">
              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="w-full text-center text-sm text-red-400 hover:text-red-300 transition-colors py-2"
                >
                  Delete List
                </button>
              ) : (
                <div className="flex items-center justify-center gap-3 py-2">
                  <button type="button" onClick={onDelete} className="text-sm text-red-400 hover:text-red-300 font-medium">
                    Confirm Delete
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)} className="text-sm text-gray-500 hover:text-white">
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
    </Modal>
  );
}
