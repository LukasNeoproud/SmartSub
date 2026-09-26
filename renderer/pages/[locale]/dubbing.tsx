/**
 * 配音工作台页面（薄壳）：字幕 + 可选视频 → 逐条 TTS → 时间轴对齐 → 导出。
 * 支持 `?subtitle=&video=` query 预填（主流程完成横幅衔接），
 * `?session=&workItem=` 为最近任务回开的会话恢复参数。
 */
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { DubbingPanel } from '@/components/dubbing';
import DocumentaryPanel from '@/components/documentary/DocumentaryPanel';
import { Button } from '@/components/ui/button';

export default function DubbingPage() {
  const router = useRouter();
  const { t } = useTranslation('documentary');
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // 等 query 就绪再挂载面板，保证衔接入口的预填参数进入初始状态
  if (!mounted || !router.isReady) return null;

  const queryString = (key: string) =>
    typeof router.query[key] === 'string'
      ? (router.query[key] as string)
      : undefined;
  const initialSubtitlePath = queryString('subtitle');
  const initialVideoPath = queryString('video');
  const initialSessionId = queryString('session');
  const initialProofreadDataFile = queryString('proofreadData');
  const workItemId = queryString('workItem');
  // 检查员模式：配音确认检查点的流水线上下文（切换待检文件时以 key 重挂载面板）
  const gateProject = queryString('gateProject');
  const gateFile = queryString('gateFile');
  const documentary = queryString('mode') === 'documentary' && !gateProject;

  // Route changes pass through the existing unsaved-work navigation guard.
  const switchMode = (enabled: boolean) => {
    void router.push({ pathname: router.pathname, query: {
      ...router.query, mode: enabled ? 'documentary' : 'standard',
    } }, undefined, { shallow: true }).catch((error) => {
      if (!error?.cancelled) console.error('Could not switch dubbing mode', error);
    });
  };

  // 编辑器页版式：无页内大标题（定位由顶栏面包屑承担），内容区直接是工作面板
  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden p-3">
      {!gateProject && <div className="flex shrink-0 gap-2">
        <Button variant={documentary ? 'outline' : 'default'} onClick={() => switchMode(false)}>{t('standardMode')}</Button>
        <Button variant={documentary ? 'default' : 'outline'} onClick={() => switchMode(true)}>{t('title')}</Button>
      </div>}
      <div className="min-h-0 flex-1">
        {documentary ? <DocumentaryPanel /> : <DubbingPanel
          key={`${initialSessionId ?? ''}:${gateFile ?? ''}`}
          initialSubtitlePath={initialSubtitlePath}
          initialVideoPath={initialVideoPath}
          initialSessionId={initialSessionId}
          initialProofreadDataFile={initialProofreadDataFile}
          workItemId={workItemId}
          gateProject={gateProject}
          gateFile={gateFile}
        />}
      </div>
    </div>
  );
}

export const getStaticProps = makeStaticProperties([
  'common',
  'dubbing',
  'voiceClone',
  'documentary',
]);
export { getStaticPaths };
