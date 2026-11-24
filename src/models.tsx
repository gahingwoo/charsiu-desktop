// The models dialog: what is on this computer, and charsiu's own list of
// models it can run, each downloaded with `charsiu pull NAME` (which checks
// the sha256 and keeps the file only if charsiu can run it). The progress is
// the size of the .part file the download writes.
// SPDX-License-Identifier: GPL-2.0-only
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Button, Content, Flex, Modal, ModalBody, ModalFooter, ModalHeader, Progress, ProgressMeasureLocation, ProgressSize,
  Stack, Title,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { invoke, size, type Models, type PullStatus, type Settings, type Snapshot } from './api';
import { useI18n } from './i18n';

export function ModelsModal({ models, error, pull, setPull, settings, backend, onRefresh, onUse, onClose }: {
  models: Models | null; error: string; pull: PullStatus | null; setPull: (p: PullStatus | null) => void;
  settings: Settings; backend: Snapshot; onRefresh: () => Promise<void>; onUse: (path: string) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState('');
  const [rmError, setRmError] = useState('');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => { onRefresh(); }, [onRefresh]);
  useEffect(() => () => window.clearInterval(timer.current), []);

  const inUse = (path: string) => {
    if (settings.model) return settings.model === path;
    return backend.model === path || models?.current === path;
  };

  const poll = async () => {
    const p = await invoke<PullStatus>('pull_status');
    setPull(p);
    if (p.state !== 'running') {
      window.clearInterval(timer.current);
      timer.current = undefined;
      await onRefresh();
      // the first model on a fresh install: serve it straight away
      if (p.state === 'done' && backend.state === 'failed' && models) {
        const r = models.zoo.find((z) => z.name === p.name);
        const dir = models.dir.replace(/[\\/]+$/, '');
        if (r) onUse(`${dir}${dir.includes('\\') ? '\\' : '/'}${r.file}`);
      }
    }
  };

  const start = async (name: string) => {
    const r = models?.zoo.find((z) => z.name === name);
    if (!r || !models) return;
    try {
      await invoke('pull_start', {
        charsiu: settings.charsiuPath,
        req: { name: r.name, file: r.file, mmproj: r.mmproj || '', totalMb: r.totalMb, dir: models.dir },
      });
    } catch (e) {
      setPull({ name, state: 'failed', message: String(e), bytes: 0, total: 0 });
      return;
    }
    window.clearInterval(timer.current);
    timer.current = window.setInterval(poll, 500);
    poll();
  };

  const cancel = async () => { await invoke('pull_cancel'); await poll(); };

  const remove = async (file: string, path: string) => {
    if (armed !== path) { setArmed(path); return; }
    setArmed('');
    try {
      await invoke('model_remove', { charsiu: settings.charsiuPath, file });
      setRmError('');
    } catch (e) { setRmError(String(e)); }
    await onRefresh();
  };

  const running = pull?.state === 'running';
  return (
    <Modal isOpen variant="large" onClose={onClose} aria-labelledby="models-title" id="models-dialog">
      <ModalHeader title={t('models.title')} labelId="models-title"
        description={models ? t('models.where', { dir: models.dir }) : undefined} />
      <ModalBody>
        <Stack hasGutter>
          {error && <Alert isInline variant="danger" title={t('models.loadError', { msg: error })} />}
          {rmError && <Alert isInline variant="danger" title={rmError} />}
          {pull?.state === 'failed' && <Alert isInline variant="danger" title={t('models.failed', { msg: pull.message || '' })} />}
          {pull?.state === 'cancelled' && <Alert isInline variant="info" title={t('models.cancelled')} />}
          {pull?.state === 'done' && <Alert isInline variant="success" title={t('models.done', { name: pull.name })} />}
          {!models && !error && <Content component="p">{t('models.loading')}</Content>}
          {models && (
            <>
              <Title headingLevel="h3" className="regular">{t('models.installed')}</Title>
              {!models.installed.length ? <Content component="p">{t('models.none')}</Content> : (
                <Table aria-label={t('models.installed')} variant="compact" gridBreakPoint="grid-md">
                  <Thead><Tr>
                    <Th>{t('models.colName')}</Th><Th>{t('models.colSize')}</Th><Th>{t('models.colStatus')}</Th><Th screenReaderText={t('menu.options')} />
                  </Tr></Thead>
                  <Tbody>
                    {models.installed.map((m) => {
                      const using = inUse(m.path);
                      return (
                        <Tr key={m.path}>
                          <Td dataLabel={t('models.colName')}><span className="selectable" title={m.path}>{m.file}</span></Td>
                          <Td dataLabel={t('models.colSize')} className="nowrap">{size(m.bytes)}</Td>
                          <Td dataLabel={t('models.colStatus')}>
                            {using ? t('models.inUse') : m.system ? (models.current === m.path ? t('models.configured') : t('models.system')) : ''}
                          </Td>
                          <Td isActionCell>
                            <Flex gap={{ default: 'gapSm' }} flexWrap={{ default: 'nowrap' }} justifyContent={{ default: 'justifyContentFlexEnd' }}>
                              {!using && <Button variant="secondary" size="sm" onClick={() => onUse(m.path)}>{t('models.use')}</Button>}
                              {!m.system && !using && (
                                <Button variant={armed === m.path ? 'danger' : 'link'} isDanger={armed !== m.path} size="sm"
                                  onClick={() => remove(m.file, m.path)}>
                                  {t(armed === m.path ? 'models.confirmRemove' : 'models.remove')}
                                </Button>
                              )}
                            </Flex>
                          </Td>
                        </Tr>
                      );
                    })}
                  </Tbody>
                </Table>
              )}
              <Title headingLevel="h3" className="regular">{t('models.available')}</Title>
              <Table aria-label={t('models.available')} variant="compact" gridBreakPoint="grid-md">
                <Thead><Tr>
                  <Th>{t('models.colName')}</Th><Th>{t('models.colSize')}</Th><Th>{t('models.colNote')}</Th><Th screenReaderText={t('models.download')} />
                </Tr></Thead>
                <Tbody>
                  {models.zoo.map((r) => {
                    let cell: React.ReactNode;
                    if (running && pull && pull.name === r.name) {
                      const pct = pull.total ? Math.min(100, Math.floor((100 * pull.bytes) / pull.total)) : 0;
                      const label = pull.total && pull.bytes >= pull.total ? t('models.verifying')
                        : t('models.progress', { got: size(pull.bytes), total: size(pull.total) });
                      cell = (
                        <Stack>
                          <Progress value={pct} title={label} size={ProgressSize.sm} measureLocation={ProgressMeasureLocation.outside} />
                          <Button variant="link" isInline size="sm" onClick={cancel}>{t('models.cancel')}</Button>
                        </Stack>
                      );
                    } else if (r.installed) {
                      cell = t('models.downloaded');
                    } else {
                      cell = <Button variant="secondary" size="sm" isDisabled={running} onClick={() => start(r.name)}>{t('models.download')}</Button>;
                    }
                    return (
                      <Tr key={r.name}>
                        <Td dataLabel={t('models.colName')}>{r.name}</Td>
                        <Td dataLabel={t('models.colSize')} className="nowrap">{size(r.totalMb * 1048576)}</Td>
                        <Td dataLabel={t('models.colNote')} className="models-note">{r.note}</Td>
                        <Td dataLabel={t('models.download')} className="models-action">{cell}</Td>
                      </Tr>
                    );
                  })}
                </Tbody>
              </Table>
            </>
          )}
        </Stack>
      </ModalBody>
      <ModalFooter><Button variant="primary" onClick={onClose}>{t('common.close')}</Button></ModalFooter>
    </Modal>
  );
}
