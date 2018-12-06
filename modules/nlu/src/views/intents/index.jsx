import React from 'react'
import { Button, Glyphicon, ListGroup, ListGroupItem, FormGroup, InputGroup, FormControl } from 'react-bootstrap'
import _ from 'lodash'

import IntentEditor from './editor'
import style from '../style.scss'

export default class IntentsComponent extends React.Component {
  state = {
    showNavIntents: true,
    intents: [],
    currentIntent: null,
    filterValue: '',
    isSyncing: false
  }

  componentDidMount() {
    this.fetchIntents()
    this.maybeSyncModel()
  }

  // Deprecated, will be fixed when we fix the whole NLU UI
  componentWillReceiveProps(nextProps) {
    if (nextProps.intent !== this.props.intent) {
      this.initiateStateFromProps(nextProps)
    }
  }

  maybeSyncModel = _.throttle(() => {
    this.props.bp.axios.get('/mod/nlu/sync/check').then(res => {
      if (res.data) {
        this.setState({ isSyncing: true }, this.syncModel)
      } else {
        this.setState({ isSyncing: false })
      }
    })
  }, 1000)

  fetchIntents = () => {
    return this.props.bp.axios.get('/mod/nlu/intents').then(res => {
      const dataToSet = { intents: res.data }

      if (!this.state.currentIntent) {
        dataToSet.currentIntent = _.get(_.first(res.data), 'name')
      }

      this.setState(dataToSet)
    })
  }

  toggleProp = prop => () => {
    this.setState({ [prop]: !this.state[prop] })
  }

  getIntents = () => this.state.intents || []

  getCurrentIntent = () => _.find(this.getIntents(), { name: this.state.currentIntent })

  onFilterChanged = event => this.setState({ filterValue: event.target.value })

  setCurrentIntent = name => {
    if (this.state.currentIntent !== name) {
      if (this.intentEditor && this.intentEditor.onBeforeLeave) {
        if (this.intentEditor.onBeforeLeave() !== true) {
          return
        }
      }

      this.setState({ currentIntent: name })
    }
  }

  createNewIntent = () => {
    const name = prompt('Enter the name of the new intent')

    if (!name || !name.length) {
      return
    }

    if (/[^a-z0-9-_.]/i.test(name)) {
      alert('Invalid name, only alphanumerical characters, underscores and hypens are accepted')
      return this.createNewIntent()
    }

    return this.props.bp.axios
      .post(`/mod/nlu/intents/${name}`, {
        utterances: [],
        slots: []
      })
      .then(this.fetchIntents)
      .then(() => this.setCurrentIntent(name))
  }

  getFilteredIntents() {
    return this.getIntents().filter(i => {
      if (this.state.filterValue.length && !i.name.toLowerCase().includes(this.state.filterValue.toLowerCase())) {
        return false
      }
      return true
    })
  }

  deleteIntent = intent => {
    const confirmDelete = window.confirm(`Are you sure you want to delete the intent "${intent}" ?`)
    if (confirmDelete) {
      return this.props.bp.axios.delete(`/mod/nlu/intents/${intent}`).then(this.fetchIntents)
    }
  }

  renderCategory() {
    const intents = this.getFilteredIntents()

    return (
      <div className={style.intentsContainer}>
        <div className={style.list}>
          <ListGroup>
            {intents.map((el, i) => (
              <ListGroupItem
                key={`nlu_entity_${el.name}`}
                className={style.entity}
                onClick={() => this.setCurrentIntent(el.name)}
              >
                {el.name}
                &nbsp;(
                {_.get(el, 'utterances.length', 0)})
                <Glyphicon glyph="trash" className={style.deleteEntity} onClick={() => this.deleteIntent(el.name)} />
              </ListGroupItem>
            ))}
          </ListGroup>
        </div>
      </div>
    )
  }

  onUtterancesChange = () => {
    this.maybeSyncModel()
  }

  render() {
    return (
      <div className={style.workspace}>
        <div>
          <div className={style.main}>
            <nav className={style.navigationBar}>
              <div className={style.create}>
                <Button bsStyle="primary" block onClick={this.createNewIntent}>
                  Create new intent
                </Button>
              </div>
              <div className={style.sync}>
                {this.state.isSyncing ? (
                  <div className={style.out}>
                    <Glyphicon glyph="refresh" />
                    &nbsp;Syncing Model
                  </div>
                ) : (
                  <div className={style.in}>
                    <Glyphicon glyph="ok" />
                    &nbsp;Model is up to date
                  </div>
                )}
              </div>

              <div className={style.filter}>
                <FormGroup bsSize="large">
                  <InputGroup>
                    <FormControl type="text" placeholder="Search" onChange={this.onFilterChanged} />
                    <InputGroup.Addon>
                      <Glyphicon glyph="search" />
                    </InputGroup.Addon>
                  </InputGroup>
                </FormGroup>
              </div>
              <div className={style.list}>{this.renderCategory()}</div>
            </nav>
            <div className={style.childContent}>
              <IntentEditor
                ref={el => (this.intentEditor = el)}
                intent={this.getCurrentIntent()}
                router={this.props.router}
                axios={this.props.bp.axios}
                reloadIntents={this.fetchIntents}
                onUtterancesChange={this.onUtterancesChange}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }
}
