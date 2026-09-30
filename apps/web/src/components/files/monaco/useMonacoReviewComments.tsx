import type * as Monaco from "monaco-editor/editor/editor.api.js";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment } from "~/reviewCommentContext";

import { DiffCommentAnnotation } from "../../diffs/DiffCommentAnnotation";
import { formatFileCommentRange, nextFileCommentId } from "../fileCommentAnnotations";
import type { MonacoApi } from "./monacoRuntime";

interface ReviewComment {
  readonly id: string;
  readonly kind: "draft" | "comment";
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Where the form renders; owned by the comment's overlay widget. */
  readonly domNode: HTMLDivElement;
}

/**
 * Like VS Code's zone widgets: a view zone opens the gap under the lines, and
 * an overlay widget above the text layer holds the form, so it takes clicks.
 */
interface CommentAnchor {
  /** Rendered into; lives in the overlay widget. */
  readonly domNode: HTMLDivElement;
  readonly widget: Monaco.editor.IOverlayWidget;
  readonly range: Monaco.editor.IEditorDecorationsCollection;
  zone: Monaco.editor.IViewZone;
  zoneId: string | null;
  resize: ResizeObserver;
}

const ADD_COMMENT_CLASS = "t3-monaco-comment-add";
/** Room for the comment form until it is measured; Monaco hides empty zones. */
const INITIAL_ZONE_HEIGHT_PX = 132;

/**
 * Review comments in Monaco, like the classic editor's: select lines, click
 * the gutter "+" (or "Add Comment to Chat"), and the comment joins the chat
 * composer. Comments follow their lines as the file is edited.
 */
export function useMonacoReviewComments(input: {
  readonly monaco: MonacoApi;
  readonly editor: Monaco.editor.IStandaloneCodeEditor | null;
  readonly model: Monaco.editor.ITextModel | null;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly relativePath: string;
}): ReactNode {
  const { monaco, editor, model, composerDraftTarget, relativePath } = input;
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const [comments, setComments] = useState<ReadonlyArray<ReviewComment>>([]);
  const anchorsRef = useRef(new Map<string, CommentAnchor>());

  const sendToChat = useCallback(
    (comment: ReviewComment) => {
      if (!model || comment.kind !== "comment") return;
      addReviewComment(
        composerDraftTarget,
        buildFileReviewComment({
          id: comment.id,
          filePath: relativePath,
          startLine: comment.startLine,
          endLine: comment.endLine,
          text: comment.text,
          contents: model.getValue(),
        }),
      );
    },
    [addReviewComment, composerDraftTarget, model, relativePath],
  );

  const placeZone = useCallback(
    (anchor: CommentAnchor, afterLineNumber: number) => {
      if (!editor) return;
      editor.changeViewZones((accessor) => {
        if (anchor.zoneId !== null) accessor.removeZone(anchor.zoneId);
        anchor.zone = { ...anchor.zone, afterLineNumber };
        anchor.zoneId = accessor.addZone(anchor.zone);
      });
    },
    [editor],
  );

  const dropAnchor = useCallback(
    (id: string) => {
      const anchor = anchorsRef.current.get(id);
      if (!anchor) return;
      anchorsRef.current.delete(id);
      anchor.resize.disconnect();
      anchor.range.clear();
      if (editor) {
        editor.removeOverlayWidget(anchor.widget);
        if (anchor.zoneId !== null) {
          const zoneId = anchor.zoneId;
          editor.changeViewZones((accessor) => accessor.removeZone(zoneId));
        }
      }
    },
    [editor],
  );

  const beginComment = useCallback(
    (startLine: number, endLine: number) => {
      if (!editor || !model) return;
      for (const comment of comments) {
        if (comment.kind === "draft") dropAnchor(comment.id);
      }
      const id = nextFileCommentId();
      const domNode = document.createElement("div");
      domNode.className = "t3-monaco-comment-zone";
      const placeWidget = () => {
        const layout = editor.getLayoutInfo();
        domNode.style.left = `${layout.contentLeft}px`;
        domNode.style.width = `${Math.max(
          120,
          layout.width -
            layout.contentLeft -
            layout.minimap.minimapWidth -
            layout.verticalScrollbarWidth,
        )}px`;
      };
      placeWidget();
      const widget: Monaco.editor.IOverlayWidget = {
        getId: () => `t3.reviewComment.${id}`,
        getDomNode: () => domNode,
        getPosition: () => null,
      };
      const anchor: CommentAnchor = {
        domNode,
        widget,
        range: editor.createDecorationsCollection([
          {
            range: new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)),
            options: {
              isWholeLine: true,
              className: "t3-monaco-comment-range",
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          },
        ]),
        zone: {
          afterLineNumber: endLine,
          heightInPx: INITIAL_ZONE_HEIGHT_PX,
          domNode: document.createElement("div"),
          // Follows the gap as the editor scrolls; off screen when it scrolls away.
          onDomNodeTop: (top) => {
            domNode.style.top = `${top}px`;
            placeWidget();
          },
        },
        zoneId: null,
        resize: new ResizeObserver(([entry]) => {
          const height = Math.ceil(entry?.borderBoxSize[0]?.blockSize ?? 0);
          if (!editor || anchor.zoneId === null || height === 0) return;
          if (height === anchor.zone.heightInPx) return;
          anchor.zone.heightInPx = height;
          const zoneId = anchor.zoneId;
          editor.changeViewZones((accessor) => accessor.layoutZone(zoneId));
        }),
      };
      anchorsRef.current.set(id, anchor);
      editor.addOverlayWidget(widget);
      placeZone(anchor, endLine);
      setComments((current) => [
        ...current.filter((comment) => comment.kind !== "draft"),
        { id, kind: "draft", text: "", startLine, endLine, domNode },
      ]);
    },
    [comments, dropAnchor, editor, model, monaco, placeZone],
  );
  const beginCommentRef = useRef(beginComment);
  useLayoutEffect(() => {
    beginCommentRef.current = beginComment;
  });

  // The gutter "+" beside the hovered line, and "Add Comment to Chat" in the menu.
  useEffect(() => {
    if (!editor) return;
    const hover = editor.createDecorationsCollection();
    // The line decorations strip holds the fold arrows, so the "+" lives in the
    // glyph margin, shown while the pointer is anywhere in the gutter.
    const gutterTargets = new Set([
      monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
      monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
      monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
    ]);
    const targetLine = (event: Monaco.editor.IEditorMouseEvent) =>
      gutterTargets.has(event.target.type) ? (event.target.position?.lineNumber ?? null) : null;
    const commentRange = (line: number): [number, number] => {
      const selection = editor.getSelection();
      if (!selection || selection.isEmpty()) return [line, line];
      const endLine =
        selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
          ? selection.endLineNumber - 1
          : selection.endLineNumber;
      return line >= selection.startLineNumber && line <= endLine
        ? [selection.startLineNumber, endLine]
        : [line, line];
    };
    const subscriptions = [
      editor.onMouseMove((event) => {
        const line = targetLine(event);
        hover.set(
          line === null
            ? []
            : [
                {
                  range: new monaco.Range(line, 1, line, 1),
                  options: { glyphMarginClassName: ADD_COMMENT_CLASS },
                },
              ],
        );
      }),
      editor.onMouseLeave(() => hover.clear()),
      editor.onMouseDown((event) => {
        if (
          event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
          !event.target.element?.classList.contains(ADD_COMMENT_CLASS)
        ) {
          return;
        }
        const line = event.target.position?.lineNumber;
        if (line === undefined) return;
        event.event.preventDefault();
        const [startLine, endLine] = commentRange(line);
        beginCommentRef.current(startLine, endLine);
      }),
      editor.addAction({
        id: "t3.addReviewComment",
        label: "Add Comment to Chat",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 0,
        run: (target) => {
          const selection = target.getSelection();
          if (!selection) return;
          const [startLine, endLine] = commentRange(selection.startLineNumber);
          beginCommentRef.current(startLine, endLine);
        },
      }),
    ];
    return () => {
      hover.clear();
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [editor, monaco]);

  // Comments follow their lines; a sent comment is re-sent with its new range.
  useEffect(() => {
    if (!model) return;
    const subscription = model.onDidChangeContent(() => {
      setComments((current) => {
        let changed = false;
        const next = current.map((comment) => {
          const range = anchorsRef.current.get(comment.id)?.range.getRange(0);
          if (!range) return comment;
          const endLine =
            range.endColumn === 1 && range.endLineNumber > range.startLineNumber
              ? range.endLineNumber - 1
              : range.endLineNumber;
          if (range.startLineNumber === comment.startLine && endLine === comment.endLine) {
            return comment;
          }
          changed = true;
          return { ...comment, startLine: range.startLineNumber, endLine };
        });
        return changed ? next : current;
      });
    });
    return () => subscription.dispose();
  }, [model]);

  const previousRef = useRef<ReadonlyArray<ReviewComment>>([]);
  useEffect(() => {
    const previous = new Map(previousRef.current.map((comment) => [comment.id, comment]));
    previousRef.current = comments;
    for (const comment of comments) {
      const before = previous.get(comment.id);
      if (!before) continue;
      if (before.endLine !== comment.endLine) {
        const anchor = anchorsRef.current.get(comment.id);
        if (anchor) placeZone(anchor, comment.endLine);
      }
      if (
        comment.kind === "comment" &&
        before.kind === "comment" &&
        (before.startLine !== comment.startLine || before.endLine !== comment.endLine)
      ) {
        sendToChat(comment);
      }
    }
  }, [comments, placeZone, sendToChat]);

  useEffect(() => {
    for (const anchor of anchorsRef.current.values()) {
      const content = anchor.domNode.firstElementChild;
      if (content) anchor.resize.observe(content);
    }
  });

  useEffect(
    () => () => {
      for (const id of anchorsRef.current.keys()) dropAnchor(id);
    },
    [dropAnchor],
  );

  const remove = (id: string) => {
    dropAnchor(id);
    removeReviewComment(composerDraftTarget, id);
    setComments((current) => current.filter((comment) => comment.id !== id));
    editor?.focus();
  };

  const submit = (id: string, text: string) => {
    const comment = comments.find((candidate) => candidate.id === id);
    if (!comment) return;
    const sent: ReviewComment = { ...comment, kind: "comment", text };
    sendToChat(sent);
    setComments((current) => current.map((candidate) => (candidate.id === id ? sent : candidate)));
  };

  return comments.map((comment) =>
    createPortal(
      <div className="py-1 pr-6">
        <DiffCommentAnnotation
          kind={comment.kind}
          rangeLabel={formatFileCommentRange(comment.startLine, comment.endLine)}
          text={comment.text}
          onCancel={() => remove(comment.id)}
          onComment={(text) => submit(comment.id, text)}
          onDelete={() => remove(comment.id)}
        />
      </div>,
      comment.domNode,
      comment.id,
    ),
  );
}
